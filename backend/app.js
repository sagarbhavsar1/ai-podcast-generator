const express = require("express");
const multer = require("multer");
const cors = require("cors");
const fs = require("fs-extra");
const path = require("path");
const axios = require("axios");
const rateLimit = require("express-rate-limit");
const { extractTextFromPdf } = require("./tessaractOCR");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware - SINGLE DECLARATIONS ONLY
app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

// Rate limiting
const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30, // limit each IP to 30 requests per minute (Groq's limit)
  message: "Too many requests, please try again later.",
});

// Define fixed podcast duration (10-15 min range) hard cap concept
const TARGET_PODCAST_DURATION = 12; // Target 12 minutes (middle of 10-15 range)

// Words per minute for speech calculation - adjusted for Kokoro TTS's actual speed
// Previous value was 150, but logs showed 2785 words took 13 minutes (≈214 wpm)
const WORDS_PER_MINUTE = 214; // Adjusted based on production data

// Function to calculate target word count based on duration
function calculateTargetWordCount(durationMinutes) {
  return durationMinutes * WORDS_PER_MINUTE;
}

// Function to count words in a script
function countWords(script) {
  if (!script) return 0;
  return script
    .replace(/\[.*?\]/g, "") // Remove stage directions
    .split(/\s+/)
    .filter((word) => word.length > 0).length;
}

// Modified function to verify if script meets target duration with better logging
function verifyScriptDuration(script) {
  const wordCount = countWords(script);
  const estimatedMinutes = wordCount / WORDS_PER_MINUTE;
  const varianceMinutes = 5; // How much we allow duration to vary from target
  const isWithinRange =
    Math.abs(estimatedMinutes - TARGET_PODCAST_DURATION) <= varianceMinutes;

  return {
    wordCount,
    estimatedMinutes,
    targetMinutes: TARGET_PODCAST_DURATION,
    varianceAllowed: varianceMinutes,
    acceptableRange: `${TARGET_PODCAST_DURATION - varianceMinutes}-${
      TARGET_PODCAST_DURATION + varianceMinutes
    } minutes`,
    isWithinRange,
  };
}

// Function to validate if text is an actual podcast script
function isValidPodcastScript(text) {
  // Check if the text contains Host A and Host B patterns
  const hostAPattern = /Host A:/i;
  const hostBPattern = /Host B:/i;

  // It must contain dialogue from both hosts
  if (!hostAPattern.test(text) || !hostBPattern.test(text)) {
    return false;
  }

  // Check that it's not just instructions
  const instructionPatterns = [
    /step 1:/i,
    /identify unnecessary/i,
    /simplify analytical/i,
    /streamline host/i,
    /approach to condensing/i,
    /word count monitoring/i,
  ];

  for (const pattern of instructionPatterns) {
    if (pattern.test(text)) {
      return false;
    }
  }

  return true;
}

// Configure storage for uploaded files
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, "../uploads/");
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + path.extname(file.originalname));
  },
});

const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    if (file.mimetype === "application/pdf") {
      cb(null, true);
    } else {
      cb(new Error("Only PDF files are allowed!"), false);
    }
  },
});

// Function to optimize script for TTS
function optimizeScriptForTTS(script) {
  // Split into lines
  const lines = script.split("\n");
  const optimizedLines = [];

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].trim();
    if (!line) continue;

    // Skip lines that are just stage directions
    if (line.startsWith("[") && line.endsWith("]")) continue;

    // Extract speaker and text
    const parts = line.split(":", 1);
    if (parts.length < 2) {
      optimizedLines.push(line);
      continue;
    }

    const speaker = parts[0].trim();
    let text = line.substring(parts[0].length + 1).trim();

    // Break very long sentences into shorter ones
    if (text.length > 150) {
      const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];
      text = sentences.join(" ");
    }

    // Add pauses at natural breaks
    text = text.replace(/\. /g, ". [pause] ");
    text = text.replace(/\! /g, "! [pause] ");
    text = text.replace(/\? /g, "? [pause] ");

    // Add the optimized line
    optimizedLines.push(`${speaker}: ${text}`);
  }

  return optimizedLines.join("\n");
}

// Add this near the top with other constants
const MAX_CONCURRENT_REQUESTS = 3; // Reduced from 5 to avoid rate limits
const MIN_REQUEST_INTERVAL = 1500; // Increased from 1000ms to 1500ms
const OPTIMAL_CHUNK_SIZE = 10000; // Increased from 6000 to 10000
const MAX_CHUNK_COUNT = 12; // New constant to limit total chunks

// Improved splitTextIntoChunks function
function splitTextIntoChunks(text) {
  // If text is very small, return it as is
  if (text.length < OPTIMAL_CHUNK_SIZE) {
    return [text];
  }

  // Calculate minimum number of chunks needed based on text length
  const minChunksNeeded = Math.ceil(text.length / OPTIMAL_CHUNK_SIZE);
  // Use actual chunks needed but cap at MAX_CHUNK_COUNT
  const targetChunks = Math.min(minChunksNeeded, MAX_CHUNK_COUNT);

  console.log(
    `Planning to split content into approximately ${targetChunks} chunks`
  );

  // Calculate target chunk size - larger than before to reduce chunks
  const targetChunkSize = Math.ceil(text.length / targetChunks);

  const chunks = [];
  let startIndex = 0;

  while (startIndex < text.length) {
    // Aim for target chunk size but don't exceed text length
    const idealEndIndex = startIndex + targetChunkSize;
    let endIndex = Math.min(idealEndIndex, text.length);

    // If we're not at the end, find a good breaking point
    if (endIndex < text.length) {
      // Search for break points within the last 20% of the chunk
      const searchWindowStart = Math.max(
        startIndex,
        endIndex - Math.floor(targetChunkSize * 0.2)
      );

      // Look for paragraph breaks first (double newline)
      const paragraphBreak = text.lastIndexOf("\n\n", endIndex);
      if (paragraphBreak > searchWindowStart) {
        endIndex = paragraphBreak + 2;
      } else {
        // Then look for single newline
        const lineBreak = text.lastIndexOf("\n", endIndex);
        if (lineBreak > searchWindowStart) {
          endIndex = lineBreak + 1;
        } else {
          // Then look for end of sentence
          const lastPeriod = text.lastIndexOf(".", endIndex);
          const lastQuestion = text.lastIndexOf("?", endIndex);
          const lastExclamation = text.lastIndexOf("!", endIndex);

          const maxPunctuation = Math.max(
            lastPeriod,
            lastQuestion,
            lastExclamation
          );

          if (maxPunctuation > searchWindowStart) {
            endIndex = maxPunctuation + 1;
          } else {
            // If all else fails, just use a space
            const lastSpace = text.lastIndexOf(" ", endIndex);
            if (lastSpace > searchWindowStart) {
              endIndex = lastSpace + 1;
            }
          }
        }
      }
    }

    // Add the chunk to our array
    chunks.push(text.substring(startIndex, endIndex));

    // Move to the next chunk
    startIndex = endIndex;

    // Safety check - if we've hit MAX_CHUNK_COUNT and there's still text, combine the rest
    if (chunks.length === MAX_CHUNK_COUNT - 1 && startIndex < text.length) {
      chunks.push(text.substring(startIndex));
      break;
    }
  }

  console.log(
    `Split content into ${chunks.length} chunks (average size: ${Math.round(
      text.length / chunks.length
    )} chars)`
  );
  return chunks;
}

// Add this request queue manager
class RequestQueue {
  constructor(maxConcurrent = 5, minInterval = 1000) {
    this.queue = [];
    this.activeRequests = 0;
    this.maxConcurrent = maxConcurrent;
    this.minInterval = minInterval;
    this.lastRequestTime = 0;
  }

  async add(requestFn) {
    return new Promise((resolve, reject) => {
      const execRequest = async () => {
        this.activeRequests++;

        // Ensure minimum time between requests
        const now = Date.now();
        const timeSinceLastRequest = now - this.lastRequestTime;
        if (timeSinceLastRequest < this.minInterval) {
          await new Promise((r) =>
            setTimeout(r, this.minInterval - timeSinceLastRequest)
          );
        }

        try {
          this.lastRequestTime = Date.now();
          const result = await requestFn();
          resolve(result);
        } catch (error) {
          reject(error);
        } finally {
          this.activeRequests--;
          this.processQueue();
        }
      };

      this.queue.push(execRequest);
      this.processQueue();
    });
  }

  processQueue() {
    if (this.queue.length === 0) return;
    if (this.activeRequests >= this.maxConcurrent) return;

    const nextRequest = this.queue.shift();
    nextRequest();
  }
}

// Function to process a single chunk with Groq API with retry logic (used as fallback)
async function processChunkWithGroq(
  chunk,
  isFirstChunk,
  isLastChunk,
  chunkNumber,
  totalChunks,
  targetWordCount
) {
  // Calculate per-chunk word count
  const totalTargetWords = targetWordCount;

  // Allocate words more intelligently across chunks
  const baseWordsPerChunk = Math.floor(totalTargetWords / totalChunks);

  // Improved word budget allocation:
  // 1. Increased percentage boost for first and last chunks (15% instead of 10%)
  // 2. Removed hard caps
  // 3. Consider content density for middle chunks
  let chunkWordCount;
  if (isFirstChunk) {
    chunkWordCount = Math.floor(baseWordsPerChunk * 1.15); // 15% more for intro, no cap
  } else if (isLastChunk) {
    chunkWordCount = Math.floor(baseWordsPerChunk * 1.15); // 15% more for conclusion, no cap
  } else {
    // Consider content density for middle chunks
    if (chunkNumber <= Math.ceil(totalChunks / 2)) {
      // First half chunks get a bit more words since they usually contain more core content
      chunkWordCount = Math.floor(baseWordsPerChunk * 1.05); // 5% more for first half
    } else {
      // Later chunks typically have less dense content, so they get fewer words
      chunkWordCount = Math.floor(baseWordsPerChunk * 0.9); // 10% less for second half
    }
  }

  const maxTokens = 10000;

  // Adjust system prompt based on chunk position
  let systemPrompt = `You are the world's best podcast script creator. You transform written content into authentic, engaging conversations between two hosts (Host A and Host B) that sound EXACTLY like real podcasts.

Your podcast scripts should:
1. Be genuinely conversational - not scripted-sounding narration taking turns
2. Include natural speech patterns with appropriate filler words ("um", "like", "you know") but use them sparingly
3. Feature hosts interrupting each other, finishing each other's sentences, and building on ideas
4. Include emotional reactions with clear tone indicators ("Wow!" [excited], "That's fascinating!" [curious], "Wait, really?" [surprised])
5. Have hosts ask each other questions to drive the conversation forward
6. Include brief personal anecdotes or examples that relate to the content
7. Have distinct personalities: Host A is more analytical and detail-oriented, Host B is more enthusiastic and asks clarifying questions
8. Discuss important details from the source material, focusing on key points
9. Include tangents and side discussions that naturally emerge from the content
10. Feature moments of humor, surprise, or disagreement between hosts
11. Use concise, clear sentences that are easy to speak aloud - avoid complex, run-on sentences

EXTREMELY IMPORTANT: This is part ${chunkNumber}/${totalChunks} of a podcast script. Your chunk MUST be EXACTLY ${chunkWordCount} words. No more, no less.`;

  // Adjust user prompt based on chunk position
  let userPrompt;

  if (isFirstChunk && isLastChunk) {
    // Single chunk - complete podcast
    userPrompt = `Create a complete podcast script from the following PDF content. Your script must be a natural conversation between Host A and Host B that covers the most important points.

Include a proper introduction at the beginning and a conclusion at the end.

IMPORTANT: Your script MUST be EXACTLY ${chunkWordCount} words. Focus only on the MOST important information and themes.

PDF Content: ${chunk}`;
  } else if (isFirstChunk) {
    // First chunk - include introduction
    userPrompt = `Create the first part of a podcast script from the following PDF content. Your script must be a natural conversation between Host A and Host B.

Start with a proper introduction to the topic and the hosts. This is just the beginning of the podcast, so don't conclude the discussion.

IMPORTANT: Your script MUST be EXACTLY ${chunkWordCount} words. Focus on setting up the topic and introducing key concepts from the beginning of the document.

PDF Content (Beginning): ${chunk}`;
  } else if (isLastChunk) {
    // Last chunk - include conclusion
    userPrompt = `Create the final part of a podcast script from the following PDF content. Your script must be a natural conversation between Host A and Host B.

This is the FINAL part of the podcast, so include a proper conclusion that wraps up the entire discussion naturally and satisfyingly.

IMPORTANT: Your script MUST be EXACTLY ${chunkWordCount} words. Focus on bringing the discussion to a natural conclusion that doesn't feel rushed or abrupt.

PDF Content (Ending): ${chunk}`;
  } else {
    // Middle chunk - continue conversation
    userPrompt = `Continue a podcast script from the following PDF content. Your script must be a natural conversation between Host A and Host B.

This is part ${chunkNumber} of ${totalChunks} of an ongoing podcast, so don't introduce the topic again or conclude the discussion.

IMPORTANT: Your script MUST be EXACTLY ${chunkWordCount} words. Focus only on the most important points in this section of content.

PDF Content (Middle Section): ${chunk}`;
  }

  // Implement improved retry logic with exponential backoff and jitter
  const maxRetries = 5;
  let retryCount = 0;
  let retryDelay = 2000; // Start with 2 seconds delay

  while (retryCount <= maxRetries) {
    try {
      console.log(
        `Attempting to process chunk ${chunkNumber}/${totalChunks} (Attempt ${
          retryCount + 1
        }/${maxRetries + 1})`
      );

      // Call Groq API
      const response = await axios.post(
        "https://api.groq.com/openai/v1/chat/completions",
        {
          model: "deepseek-r1-distill-llama-70b",
          messages: [
            {
              role: "system",
              content: systemPrompt,
            },
            {
              role: "user",
              content: userPrompt,
            },
          ],
          temperature: 0.7,
          max_tokens: maxTokens,
          top_p: 0.9,
        },
        {
          headers: {
            Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
            "Content-Type": "application/json",
          },
        }
      );

      console.log(`Successfully processed chunk ${chunkNumber}/${totalChunks}`);

      // Remove <think> tags if present in the response
      let content = response.data.choices[0].message.content;
      content = content.replace(/<think>[\s\S]*?<\/think>/g, "");

      return content;
    } catch (error) {
      retryCount++;

      // Check if it's a rate limit error (429)
      if (error.response && error.response.status === 429) {
        // Get retry-after header if available
        const retryAfter = error.response.headers["retry-after"];
        const waitTime = retryAfter ? parseInt(retryAfter) * 1000 : retryDelay;

        // Add jitter to avoid thundering herd problem (±20%)
        const jitter = waitTime * (0.8 + Math.random() * 0.4);

        console.log(
          `Rate limit exceeded. Waiting ${
            Math.round(jitter / 100) / 10
          } seconds before retrying...`
        );

        await new Promise((resolve) => setTimeout(resolve, jitter));
        retryDelay = Math.min(retryDelay * 1.5, 30000); // Cap at 30 seconds
      } else if (retryCount <= maxRetries) {
        // For other errors, also retry with backoff
        console.log(
          `Error processing chunk: ${error.message}. Retrying in ${
            retryDelay / 1000
          } seconds...`
        );
        await new Promise((resolve) => setTimeout(resolve, retryDelay));
        retryDelay = retryDelay * 2;
      } else {
        // If we've exhausted all retries, throw the error
        throw error;
      }
    }
  }

  throw new Error(
    `Failed to process chunk ${chunkNumber} after ${maxRetries} retries`
  );
}

// Function to trim script while preserving structure
function trimScriptPreservingStructure(script, maxWordCount) {
  // If already under limit, return as is
  const currentWordCount = countWords(script);
  if (currentWordCount <= maxWordCount) {
    return script;
  }

  console.log(
    `Smart trimming script from ${currentWordCount} to ${maxWordCount} words`
  );

  const lines = script.split("\n");
  const resultLines = [];
  let wordsAdded = 0;

  // Identify introduction and conclusion sections
  const introLines = Math.min(10, Math.floor(lines.length * 0.15)); // First 15% or max 10 lines
  const conclusionStart = Math.max(
    lines.length - 15,
    Math.floor(lines.length * 0.85)
  ); // Last 15% or last 15 lines

  // Process the script in sections (intro, middle, conclusion)
  // Always include the intro
  for (let i = 0; i < introLines; i++) {
    if (lines[i].trim()) {
      resultLines.push(lines[i]);
      wordsAdded += countWords(lines[i]);
    } else {
      resultLines.push(""); // Keep empty lines
    }
  }

  // Add middle section, limiting words
  let maxMiddleWords = Math.floor(maxWordCount * 0.7); // 70% of words for middle section
  for (let i = introLines; i < conclusionStart; i++) {
    if (!lines[i].trim()) {
      resultLines.push(""); // Keep empty lines
      continue;
    }

    const lineWords = countWords(lines[i]);
    if (wordsAdded + lineWords <= maxMiddleWords) {
      resultLines.push(lines[i]);
      wordsAdded += lineWords;
    } else {
      resultLines.push(""); // Keep empty lines
    }
  }

  // Always include conclusion
  for (let i = conclusionStart; i < lines.length; i++) {
    if (lines[i].trim()) {
      resultLines.push(lines[i]);
      wordsAdded += countWords(lines[i]);
    } else {
      resultLines.push(""); // Keep empty lines
    }
  }

  // Check if we need to add a conclusion
  const lastLines = resultLines.slice(-5).join(" ").toLowerCase();
  const conclusionPatterns = [
    "wrap up",
    "conclude",
    "to sum up",
    "in conclusion",
    "thank you for listening",
    "thanks for joining",
    "until next time",
  ];
  const hasConclusion = conclusionPatterns.some((pattern) =>
    lastLines.includes(pattern)
  );

  if (!hasConclusion) {
    // Add a natural conclusion
    resultLines.push("");
    resultLines.push(
      "Host A: Well, that brings us to the end of our discussion today. We covered a lot of ground on this fascinating topic."
    );
    resultLines.push(
      "Host B: Absolutely! I really enjoyed our conversation. There's so much depth to this subject, and I feel like we've given our listeners a good overview of the key points."
    );
    resultLines.push(
      "Host A: If you found this interesting, we encourage you to dive deeper into some of the concepts we covered today."
    );
    resultLines.push(
      "Host B: Thanks for joining us, and we hope you'll tune in next time for more engaging discussions!"
    );
  }

  return resultLines.join("\n");
}

// Fix the upload route
app.post("/api/upload", upload.single("pdf"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No PDF file uploaded" });
    }

    console.log(
      `Processing PDF: ${req.file.originalname} (${req.file.size} bytes)`
    );

    // Extract text from PDF using OCR
    const text = await extractTextFromPdf(req.file.path);

    // Log the extracted text (first 500 chars)
    console.log("Extracted text (preview):", text.substring(0, 500));
    console.log("Total text length:", text.length);
    console.log(
      "Extraction method:",
      text.length > 100 ? "Direct PDF extraction" : "OCR fallback"
    );

    // Return the extracted text
    res.json({
      text: text,
      filename: req.file.filename,
    });
  } catch (error) {
    console.error("Error processing PDF:", error);
    res.status(500).json({ error: "Failed to process PDF" });
  }
});

// Podcast generation endpoint
app.post("/api/generate", apiLimiter, async (req, res) => {
  try {
    const { text, filename, voiceOptions } = req.body;

    console.log(`===== PODCAST GENERATION STARTED =====`);
    console.log(`Source: ${filename}`);
    console.log(`Text length: ${text.length} characters`);
    console.log(`Target duration: ${TARGET_PODCAST_DURATION} minutes`);

    // Calculate target word count based on fixed duration
    const targetWordCount = calculateTargetWordCount(TARGET_PODCAST_DURATION);
    console.log(
      `Target word count: ${targetWordCount} words (at ${WORDS_PER_MINUTE} words/minute)`
    );

    let completeScript = "";

    // Try to process the entire PDF in one go
    try {
      console.log("Attempting to process entire PDF in one API call...");

      // System prompt for podcast creation
      const systemPrompt = `You are the world's best podcast script creator. You transform written content into authentic, engaging conversations between two hosts (Host A and Host B).

EXTREMELY IMPORTANT: The script MUST be EXACTLY ${targetWordCount} words to produce a ${TARGET_PODCAST_DURATION}-minute podcast. No more, no less.`;

      // User prompt for podcast creation
      const userPrompt = `Create a podcast script from the following PDF content. The script should be a natural conversation between Host A and Host B that discusses the main points and important details from the content.

Use concise sentences that are easy to speak naturally. Break up long, complex sentences into shorter ones.

EXTREMELY IMPORTANT:
1. Your script MUST be EXACTLY ${targetWordCount} words
2. Include a proper introduction, detailed discussion, and natural conclusion
3. Focus on the most important information from the source content

PDF Content: ${text}`;

      // Call Groq API with DeepSeek R1 Distill Llama 70B model
      const response = await axios.post(
        "https://api.groq.com/openai/v1/chat/completions",
        {
          model: "deepseek-r1-distill-llama-70b",
          messages: [
            {
              role: "system",
              content: systemPrompt,
            },
            {
              role: "user",
              content: userPrompt,
            },
          ],
          temperature: 0.7,
          max_tokens: 10000,
          top_p: 0.9,
        },
        {
          headers: {
            Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
            "Content-Type": "application/json",
          },
        }
      );

      console.log("Successfully processed entire PDF in one API call");

      // Remove <think> tags if present in the response
      completeScript = response.data.choices[0].message.content;
      completeScript = completeScript.replace(/<think>[\s\S]*?<\/think>/g, "");

      // Verify script duration
      const durationCheck = verifyScriptDuration(completeScript);
      console.log(`\n=== SCRIPT GENERATION RESULTS ===`);
      console.log(`Word count: ${durationCheck.wordCount} words`);
      console.log(
        `Estimated duration: ${durationCheck.estimatedMinutes.toFixed(
          1
        )} minutes`
      );
      console.log(`Target duration: ${durationCheck.targetMinutes} minutes`);
      console.log(`Acceptable range: ${durationCheck.acceptableRange}`);
      console.log(
        `Within acceptable range: ${durationCheck.isWithinRange ? "Yes" : "No"}`
      );

      // Only apply minimal protection for extreme outliers (3x target length)
      if (durationCheck.estimatedMinutes > TARGET_PODCAST_DURATION * 3) {
        console.log(
          `\n=== APPLYING TRIMMING ===\nScript is excessively long (${durationCheck.estimatedMinutes.toFixed(
            1
          )} min, > ${(TARGET_PODCAST_DURATION * 3).toFixed(1)} min threshold)`
        );
        const safeMaxWords = calculateTargetWordCount(
          TARGET_PODCAST_DURATION * 2
        );
        completeScript = trimScriptPreservingStructure(
          completeScript,
          safeMaxWords
        );
        console.log(
          `After minimal trimming: ${countWords(completeScript)} words`
        );
      } else {
        console.log(
          `\n=== NO TRIMMING NEEDED ===\nScript length (${durationCheck.estimatedMinutes.toFixed(
            1
          )} min) below ${(TARGET_PODCAST_DURATION * 3).toFixed(
            1
          )} min threshold`
        );
      }

      console.log("Script generation completed successfully");
    } catch (error) {
      console.error("Error processing entire PDF:", error.message);

      // Fallback to chunking method if we encounter an error
      if (error.response && error.response.status === 413) {
        console.log(
          "Content too large for single API call. Falling back to chunking method..."
        );
      } else if (error.response && error.response.status === 429) {
        console.log(
          "Rate limit exceeded. Falling back to chunking method with delays..."
        );
      } else {
        console.log("Unexpected error. Falling back to chunking method...");
      }

      // Split text into manageable chunks as fallback
      const chunks = splitTextIntoChunks(text);
      console.log(`Split content into ${chunks.length} chunks for processing`);

      // Create request queue to manage API requests
      const requestQueue = new RequestQueue(
        MAX_CONCURRENT_REQUESTS,
        MIN_REQUEST_INTERVAL
      );

      // Create an array to hold all chunk results in correct order
      const chunkResults = new Array(chunks.length);

      // Calculate actual target word count - aim for slightly under to avoid issues
      const actualTargetWords = targetWordCount * 0.98;
      console.log(
        `Adjusted target word count: ${Math.round(actualTargetWords)} words`
      );

      // Create promises for all chunks
      const chunkPromises = chunks.map((chunk, i) => {
        const isFirstChunk = i === 0;
        const isLastChunk = i === chunks.length - 1;

        // Add this request to the queue
        return requestQueue.add(async () => {
          console.log(`Processing chunk ${i + 1} of ${chunks.length}...`);

          // Process chunk with improved function
          const chunkScript = await processChunkWithGroq(
            chunk,
            isFirstChunk,
            isLastChunk,
            i + 1,
            chunks.length,
            Math.round(actualTargetWords)
          );

          // Store in results array at correct position
          chunkResults[i] = chunkScript;
          console.log(`Completed chunk ${i + 1} of ${chunks.length}`);
          return chunkScript;
        });
      });

      // Wait for all chunks to complete
      await Promise.all(chunkPromises);

      // Combine all chunks in correct order
      completeScript = chunkResults.join("\n\n");

      // Verify final combined script duration
      const combinedCheck = verifyScriptDuration(completeScript);
      console.log(`Combined chunks script statistics:
        - Word count: ${combinedCheck.wordCount}
        - Estimated duration: ${combinedCheck.estimatedMinutes.toFixed(
          1
        )} minutes
        - Target duration: ${combinedCheck.targetMinutes} minutes
        - Acceptable range: ${combinedCheck.acceptableRange}
        - Within acceptable range: ${
          combinedCheck.isWithinRange ? "Yes" : "No"
        }`);

      // If script is significantly longer than target, apply smart trimming - much higher threshold
      if (combinedCheck.estimatedMinutes > TARGET_PODCAST_DURATION * 3) {
        console.log(
          `Script is excessively long (${combinedCheck.estimatedMinutes.toFixed(
            1
          )} min, > ${(TARGET_PODCAST_DURATION * 3).toFixed(1)} min threshold)`
        );
        // More generous target (allow up to 50% extra length)
        const adjustedTargetWords = calculateTargetWordCount(
          TARGET_PODCAST_DURATION * 2
        );
        completeScript = trimScriptPreservingStructure(
          completeScript,
          adjustedTargetWords
        );

        const afterTrimmingCheck = verifyScriptDuration(completeScript);
        console.log(`After smart trimming:
          - Word count: ${afterTrimmingCheck.wordCount}
          - Estimated duration: ${afterTrimmingCheck.estimatedMinutes.toFixed(
            1
          )} minutes`);
      } else {
        console.log(
          `\n=== NO TRIMMING NEEDED ===\nScript length (${combinedCheck.estimatedMinutes.toFixed(
            1
          )} min) below ${(TARGET_PODCAST_DURATION * 3).toFixed(
            1
          )} min threshold`
        );
      }

      console.log("Script generation completed successfully");
    }

    // Optimize the script for TTS
    const optimizedScript = optimizeScriptForTTS(completeScript);

    const scriptData = {
      script: optimizedScript,
    };

    // Generate audio using voice_service.py
    console.log("Generating audio with Kokoro TTS...");
    const { spawn } = require("child_process");
    const audioProcess = spawn("python", ["voice_service.py"]);

    let audioOutput = "";

    audioProcess.stdout.on("data", (data) => {
      audioOutput += data.toString();
    });

    audioProcess.stderr.on("data", (data) => {
      console.error(`TTS Error: ${data.toString()}`);
    });

    audioProcess.on("error", (error) => {
      console.error("Error spawning audio process:", error);
      return res
        .status(500)
        .json({ error: "Failed to generate podcast audio" });
    });

    // Pass voice options if provided
    const inputData = {
      script: scriptData.script,
      voices: voiceOptions || { hostA: "af_bella", hostB: "am_echo" }, // Updated to bella and echo
    };

    audioProcess.stdin.write(JSON.stringify(inputData));
    audioProcess.stdin.end();

    await new Promise((resolve, reject) => {
      audioProcess.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`TTS process exited with code ${code}`));
      });
    });

    let audioData;
    try {
      // Look for the last line that contains valid JSON
      const lines = audioOutput.trim().split("\n");
      let jsonLine = "";
      for (let i = lines.length - 1; i >= 0; i--) {
        if (lines[i].trim().startsWith("{")) {
          jsonLine = lines[i];
          break;
        }
      }

      if (jsonLine) {
        audioData = JSON.parse(jsonLine);
        console.log("Parsed audio data:", audioData);
      } else {
        throw new Error("No valid JSON found in output");
      }
    } catch (e) {
      console.error("Failed to parse audio output:", e.message);
      console.error("Raw audio output:", audioOutput);
      return res.status(500).json({ error: "Invalid audio output" });
    }

    console.log(`Podcast generated successfully: ${audioData.audio_file}`);

    // Return podcast data
    res.json({
      script: scriptData.script,
      audioUrl: `/podcasts/${path.basename(audioData.audio_file)}`,
    });
  } catch (error) {
    console.error("Error generating podcast:", error);
    res.status(500).json({ error: "Failed to generate podcast" });
  }
});

// Serve static files from the public directory
app.use(
  "/podcasts",
  express.static(path.join(__dirname, "../public/podcasts"))
);

// Basic health check endpoint
app.get("/api/health", (req, res) => {
  res.json({ status: "Server is running" });
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
