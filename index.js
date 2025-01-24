import axios from 'axios';
import chalk from 'chalk';
import qrcode from 'qrcode-terminal';
import whatsappweb from 'whatsapp-web.js';
import fs from 'fs';
import { createRequire } from 'module'; // Add this line
import sharp from 'sharp'; // Add this line
import http from 'http'; // Add this import

const require = createRequire(import.meta.url); // Add this line
const Jimp = require('jimp'); // Direct require without destructuring

const { Client, LocalAuth, MessageMedia } = whatsappweb;

// Remove express-related code and keep environment variable
process.env.PORT || 3000; // This satisfies Render's port requirement without needing a server

// Initialize WhatsApp client first, before server code
const client = new Client({
    authStrategy: new LocalAuth({
        clientId: 'whatsapp-bot',
        dataPath: SESSION_DIR
    }),
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--disable-gpu',
            '--aggressive-cache-discard',
            '--disable-cache',
            '--disable-application-cache',
            '--disable-offline-load-stale-cache',
            '--disk-cache-size=0',
            '--disable-background-networking',
            '--disable-default-apps',
            '--disable-extensions',
            '--disable-sync',
            '--disable-translate',
            '--hide-scrollbars',
            '--metrics-recording-only',
            '--mute-audio',
            '--no-first-run',
            '--safebrowsing-disable-auto-update'
        ],
        timeout: 30000,
        defaultViewport: null,
        handleSIGINT: false,
        handleSIGTERM: false
    },
    takeoverOnConflict: true,
    takeoverTimeoutMs: 10000
});

// Move server code after client initialization but before starting anything
const DEFAULT_PORT = 3000;
let PORT;
let serverInstance;

// Modify startup sequence
const startServices = async () => {
    console.log(chalk.yellow('Starting services...\n'));
    
    try {
        // Start HTTP server first
        PORT = process.env.PORT ? parseInt(process.env.PORT) : DEFAULT_PORT;
        
        const server = http.createServer((req, res) => {
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            res.end('WhatsApp Bot is running\n');
        });

        // Wait for server to start
        serverInstance = await new Promise((resolve, reject) => {
            server.on('error', (err) => {
                if (err.code === 'EADDRINUSE') {
                    console.log(chalk.yellow(`Port ${PORT} is busy, trying ${PORT + 1}...`));
                    PORT++;
                    server.listen(PORT);
                } else {
                    reject(err);
                }
            });

            server.listen(PORT, () => {
                console.log(chalk.blue(`HTTP server running on port ${PORT}`));
                if (process.env.PORT) {
                    console.log(chalk.blue(`Detected service running on port ${process.env.PORT}`));
                }
                resolve(server);
            });
        });

        // Small delay to ensure server is stable
        await new Promise(resolve => setTimeout(resolve, 1000));

        // Now initialize WhatsApp client
        console.log(chalk.yellow('\nStarting WhatsApp client...'));
        await client.initialize();
        
        return true;
    } catch (error) {
        console.error(chalk.red('Startup error:'), error);
        process.exit(1);
    }
};

// Replace the old initialization code with this
(async () => {
    try {
        await startServices();
    } catch (error) {
        console.error(chalk.red('Fatal error during startup:'), error);
        process.exit(1);
    }
})();

// Configure retry and rate limiting
const MAX_RETRIES = 3;
const RETRY_DELAY = 5000;
const BOT_PREFIX = 'okeyai';
const IMAGE_COMMAND = 'imagine';
const IMAGE_TIMEOUT = 60000; // 60 seconds timeout for image generation

// Performance optimization
const PERFORMANCE_OPTS = {
    MESSAGE_DELAY: 0,
    TYPING_MIN: 0,
    TYPING_MAX: 100,
    API_TIMEOUT: 5000,
    CACHE_DURATION: 300000,
    MAX_CONCURRENT: 50,
    QUEUE_CHECK: 100,
    // Add rate limiting settings
    DAILY_LIMIT: 2000,     // 2000 messages per day per instance
    HOURLY_LIMIT: 200,     // 200 messages per hour
    USER_HOURLY_LIMIT: 100 // 100 messages per hour per user
};

// Remove old timing constants and use PERFORMANCE_OPTS instead
const MESSAGE_QUEUE_INTERVAL = PERFORMANCE_OPTS.MESSAGE_DELAY;
const TYPING_DURATION = { 
    MIN: PERFORMANCE_OPTS.TYPING_MIN, 
    MAX: PERFORMANCE_OPTS.TYPING_MAX 
};
const API_TIMEOUT = PERFORMANCE_OPTS.API_TIMEOUT;
const CACHE_DURATION = PERFORMANCE_OPTS.CACHE_DURATION;
const MAX_CONCURRENT_CHATS = PERFORMANCE_OPTS.MAX_CONCURRENT;
const DAILY_MESSAGE_LIMIT = PERFORMANCE_OPTS.DAILY_LIMIT;
const HOURLY_MESSAGE_LIMIT = PERFORMANCE_OPTS.HOURLY_LIMIT;

// Create sessions directory if it doesn't exist
const SESSION_DIR = './.wwebjs_auth';
if (!fs.existsSync(SESSION_DIR)) {
    fs.mkdirSync(SESSION_DIR, { recursive: true });
}

// Add these utility functions before MessageQueue class
const splitMessage = (text) => {
    const MAX_LENGTH = 990;
    if (text.length <= MAX_LENGTH) return [text];

    const segments = [];
    let currentSegment = "";
    
    // Split by sentences first
    const sentences = text.split(/(?<=[.!?])\s+/);
    
    for (const sentence of sentences) {
        if ((currentSegment + sentence).length <= MAX_LENGTH) {
            currentSegment += (currentSegment ? " " : "") + sentence;
        } else {
            if (currentSegment) segments.push(currentSegment);
            
            // If single sentence is too long, split by words
            if (sentence.length > MAX_LENGTH) {
                const words = sentence.split(" ");
                currentSegment = "";
                
                for (const word of words) {
                    if ((currentSegment + " " + word).length <= MAX_LENGTH) {
                        currentSegment += (currentSegment ? " " : "") + word;
                    } else {
                        if (currentSegment) segments.push(currentSegment);
                        currentSegment = word;
                    }
                }
            } else {
                currentSegment = sentence;
            }
        }
    }
    
    if (currentSegment) segments.push(currentSegment);
    
    // Add continuation markers
    return segments.map((segment, index) => 
        `${segment.trim()}${index < segments.length - 1 ? ' (continued...)' : ''}`
    );
};

// Add new utility function for image generation
const generateImage = async (prompt) => {
    const encodedPrompt = encodeURIComponent(prompt);
    const imageUrl = `https://image.pollinations.ai/prompt/${encodedPrompt}?model=flux-pro&nologo=true&enhance=true&private=true`;
    
    // Pre-fetch image to ensure it's ready
    await axios.head(imageUrl);
    return imageUrl;
};

// Add new utility function for watermarking images
async function addWatermark(imageBuffer) {
    try {
        const watermarkText = "OkeyMeta AI";
        
        // Create SVG text overlay
        const svgText = `
            <svg width="200" height="50">
                <rect x="0" y="0" width="200" height="50" fill="rgba(0,0,0,0.5)"/>
                <text x="10" y="35" font-family="Arial" font-size="24" fill="white">${watermarkText}</text>
            </svg>
        `;

        // Process image with sharp
        const processedImage = await sharp(imageBuffer)
            .composite([{
                input: Buffer.from(svgText),
                gravity: 'southeast',
            }])
            .jpeg()
            .toBuffer();

        return processedImage;
    } catch (error) {
        console.error(chalk.red('Error adding watermark:'), error);
        console.error(error.stack);
        throw error;
    }
}

// Add image generation tracking
const activeImageGenerations = new Map();

// Modify the sendWhatsAppImage function
async function sendWhatsAppImage(chat, caption, imageUrl) {
    try {
        const response = await axios.get(imageUrl, { 
            responseType: 'arraybuffer',
            timeout: 30000 // 30 second timeout
        });
        
        const watermarkedBuffer = await addWatermark(response.data);
        
        const media = new MessageMedia(
            'image/jpeg',
            watermarkedBuffer.toString('base64'),
            'generated_image.jpg'
        );
        
        await chat.sendMessage(media, { caption });
    } catch (error) {
        console.error(chalk.red('Error sending image:'), error);
        await chat.sendMessage("Sorry, I couldn't process the generated image. Please try again.");
    }
}

// Add response cache and duration constants
const messageCache = new Map();
const CONCURRENT_API_CALLS = 10; // Increase concurrent API calls

// Memory optimization
const gcInterval = setInterval(() => {
    try {
        if (global.gc) {
            global.gc();
        }
    } catch (e) {
        console.log('Garbage collection not exposed');
    }
}, 30000);

// Add API rate limiter
const apiCallsInProgress = new Set();
async function makeApiCall(url, params) {
    const cacheKey = JSON.stringify(params);
    if (messageCache.has(cacheKey)) {
        return { data: { response: messageCache.get(cacheKey) } };
    }

    while (apiCallsInProgress.size >= PERFORMANCE_OPTS.MAX_CONCURRENT) {
        await new Promise(resolve => setTimeout(resolve, PERFORMANCE_OPTS.QUEUE_CHECK));
    }
    
    const callId = Date.now();
    apiCallsInProgress.add(callId);
    
    try {
        const response = await axios.get(url, {
            params,
            timeout: PERFORMANCE_OPTS.API_TIMEOUT,
            headers: {
                'Connection': 'close',
                'Accept': 'application/json',
                'Cache-Control': 'no-cache'
            }
        });
        
        if (response.data?.response) {
            messageCache.set(cacheKey, response.data.response);
            setTimeout(() => messageCache.delete(cacheKey), CACHE_DURATION);
        }
        
        return response;
    } finally {
        apiCallsInProgress.delete(callId);
    }
}

// Message queue and rate limiting
class MessageQueue {
    constructor() {
        this.queue = new Map(); // Queue for each user
        this.messageCount = new Map(); // Track message counts
        this.activeChatCount = 0;
        this.dailyMessages = 0;
        this.hourlyMessages = 0;
        this.lastReset = Date.now();
        this.userLastMessage = new Map(); // Track last message time per user
        this.userMessageCount = new Map(); // Track message count per user
        this.processingQueues = new Set();
        
        // Reset counters periodically
        setInterval(() => this.resetHourlyCount(), 3600000); // Reset hourly
        setInterval(() => this.resetDailyCount(), 86400000); // Reset daily
    }

    resetHourlyCount() {
        this.hourlyMessages = 0;
    }

    resetDailyCount() {
        this.dailyMessages = 0;
    }

    async checkUserRateLimit(userId) {
        const now = Date.now();
        const lastMessage = this.userLastMessage.get(userId) || 0;
        const userCount = this.userMessageCount.get(userId) || 0;
        
        // Reset user count if last message was more than an hour ago
        if (now - lastMessage > 3600000) {
            this.userMessageCount.set(userId, 0);
            return true;
        }

        // Use PERFORMANCE_OPTS for user limits
        if (userCount >= PERFORMANCE_OPTS.USER_HOURLY_LIMIT) {
            return false;
        }

        // Minimum 1 second gap between messages
        if (now - lastMessage < 1000) {
            return false;
        }

        return true;
    }

    canProcessMessage() {
        const now = Date.now();
        
        // Reset counters if a day has passed
        if (now - this.lastReset > 86400000) {
            this.resetDailyCount();
            this.resetHourlyCount();
            this.lastReset = now;
        }

        // Use proper rate limits from PERFORMANCE_OPTS
        return this.activeChatCount < PERFORMANCE_OPTS.MAX_CONCURRENT &&
               this.dailyMessages < PERFORMANCE_OPTS.DAILY_LIMIT &&
               this.hourlyMessages < PERFORMANCE_OPTS.HOURLY_LIMIT;
    }

    async addToQueue(chat, message, handler) {
        const userId = message.from;

        // Mark message as seen immediately
        await chat.sendSeen();
        
        if (!await this.checkUserRateLimit(userId)) {
            await client.sendMessage(userId, 
                "Please wait a moment before sending more messages. This helps maintain service quality.");
            return;
        }

        // Update user message tracking
        this.userLastMessage.set(userId, Date.now());
        this.userMessageCount.set(userId, (this.userMessageCount.get(userId) || 0) + 1);

        if (!this.queue.has(userId)) {
            this.queue.set(userId, []);
            this.messageCount.set(userId, 0);
        }

        this.queue.get(userId).push({ chat, message, handler });
        
        // Start processing queue for this user if not already processing
        if (this.queue.get(userId).length === 1) {
            this.processQueue(userId);
        }
    }

    async processQueue(userId) {
        if (this.processingQueues.has(userId)) return;
        this.processingQueues.add(userId);
        
        const userQueue = this.queue.get(userId);
        while (userQueue && userQueue.length > 0) {
            if (!this.canProcessMessage()) {
                await new Promise(resolve => setTimeout(resolve, PERFORMANCE_OPTS.QUEUE_CHECK));
                continue;
            }

            const { chat, message, handler } = userQueue[0];
            
            try {
                this.activeChatCount++;
                this.dailyMessages++;
                this.hourlyMessages++;
                
                // Use proper typing duration
                const typingDuration = Math.min(
                    Math.max(message.body.length * 25, TYPING_DURATION.MIN),
                    TYPING_DURATION.MAX
                );
                
                await chat.sendStateTyping();
                await new Promise(resolve => setTimeout(resolve, typingDuration));
                
                const result = await handler();
                if (result) {
                    const segments = splitMessage(result);
                    for (const segment of segments) {
                        await chat.sendStateTyping();
                        await client.sendMessage(message.from, segment);
                        if (segments.length > 1) {
                            await new Promise(resolve => setTimeout(resolve, MESSAGE_QUEUE_INTERVAL));
                        }
                    }
                }
                
            } catch (error) {
                console.error(chalk.red(`Error processing message for user ${userId}:`), error);
                if (error.message.includes('timeout')) {
                    await client.sendMessage(message.from, 
                        "I'm experiencing a delay. Please try again.");
                }
            } finally {
                this.activeChatCount--;
                userQueue.shift();
                
                // Use MESSAGE_QUEUE_INTERVAL for delays
                if (userQueue.length > 0) {
                    await new Promise(resolve => setTimeout(resolve, MESSAGE_QUEUE_INTERVAL));
                }
            }
        }

        // Proper cleanup
        if (userQueue && userQueue.length === 0) {
            this.queue.delete(userId);
            this.messageCount.delete(userId);
            this.userLastMessage.delete(userId);
            this.userMessageCount.delete(userId);
        }
    }
}

// Instantiate message queue
const messageQueue = new MessageQueue();

// Connection status tracking
let isConnected = false;
let reconnectAttempts = 0;

// Connection state management
const handleConnectionState = (state) => {
    console.log(chalk.yellow(`Connection state: ${state}`));
    isConnected = state === 'CONNECTED';
};

// Implement reconnection logic
const reconnect = async () => {
    if (reconnectAttempts < MAX_RETRIES) {
        reconnectAttempts++;
        console.log(chalk.yellow(`Attempting to reconnect... (Attempt ${reconnectAttempts}/${MAX_RETRIES})`));
        
        try {
            await client.initialize();
        } catch (error) {
            console.error(chalk.red('Reconnection failed:'), error);
            setTimeout(reconnect, RETRY_DELAY);
        }
    } else {
        console.error(chalk.red('Max reconnection attempts reached. Please restart the application.'));
        process.exit(1);
    }
};

// QR code event handler
client.on('qr', (qr) => {
    console.clear();
    console.log('\nScan QR Code:\n');
    qrcode.generate(qr, { 
        small: true,
        scale: 1,
        margin: 0,
        width: 30
    });
});

// Authentication event handlers
client.on('authenticated', () => {
    console.log(chalk.green('WhatsApp authentication successful!\n'));
    reconnectAttempts = 0;
    handleConnectionState('AUTHENTICATED');
});

client.on('auth_failure', async (message) => {
    console.error(chalk.red('WHATSAPP AUTHENTICATION FAILURE:'), message);
    handleConnectionState('AUTH_FAILURE');
    await reconnect();
});

// Ready event handler
client.on('ready', () => {
    isConnected = true;
    handleConnectionState('CONNECTED');
    console.log(chalk.green('OkeyAI is ready and connected!\n'));
    console.log(chalk.greenBright('OkeyAI activated. Listening for messages...\n'));
    // Store bot start time
    global.botStartTime = Date.now();
});

// Add connection keep-alive
let connectionCheckInterval;
const startConnectionCheck = () => {
    if (connectionCheckInterval) clearInterval(connectionCheckInterval);
    connectionCheckInterval = setInterval(async () => {
        if (!isConnected) {
            console.log(chalk.yellow('Connection check: Reconnecting...'));
            try {
                await client.initialize();
            } catch (error) {
                console.error(chalk.red('Connection check failed:'), error);
            }
        }
    }, 15000); // Check every 15 seconds
};

// Update ready handler
client.on('ready', () => {
    isConnected = true;
    handleConnectionState('CONNECTED');
    console.log(chalk.green('\nOkeyAI is ready and connected!'));
    console.log(chalk.greenBright('OkeyAI activated. Listening for messages...'));
    startConnectionCheck();
    
    // Reset message queue on ready
    messageQueue.queue.clear();
    messageQueue.processingQueues.clear();
});

// Disconnection handler
client.on('disconnected', async (reason) => {
    console.log(chalk.red('Client disconnected:'), reason);
    isConnected = false;
    handleConnectionState('DISCONNECTED');
    await reconnect();
});

// Message handler with retry mechanism
client.on('message', async (message) => {
    if (!isConnected) return;

    try {
        const chat = await message.getChat();
        const trimmedMessage = message.body.trim();
        
        // Early return if empty message
        if (!trimmedMessage) return;

        const isGroupChat = chat.id._serialized.endsWith('@g.us');
        let processedMessage = trimmedMessage;
        let shouldProcess = false;
        let isImageRequest = false;

        // Check for image generation command
        const lowerCaseMsg = trimmedMessage.toLowerCase();
        if (lowerCaseMsg.startsWith(`${BOT_PREFIX} ${IMAGE_COMMAND}`) || 
            (!isGroupChat && lowerCaseMsg.startsWith(IMAGE_COMMAND))) {
            
            isImageRequest = true;
            const prompt = isGroupChat ? 
                trimmedMessage.slice(`${BOT_PREFIX} ${IMAGE_COMMAND}`.length).trim() :
                trimmedMessage.slice(IMAGE_COMMAND.length).trim();

            if (!prompt) {
                await chat.sendMessage("Please provide a description of what you want to imagine.");
                return;
            }

            // Check if already generating for this chat
            if (activeImageGenerations.has(chat.id._serialized)) {
                await chat.sendMessage("I'm already generating an image for you. Please wait...");
                return;
            }

            try {
                activeImageGenerations.set(chat.id._serialized, true);
                await chat.sendMessage("🎨 Generating your image...");

                // Generate image with timeout
                const imagePromise = generateImage(prompt);
                const timeoutPromise = new Promise((_, reject) =>
                    setTimeout(() => reject(new Error('Image generation timed out')), IMAGE_TIMEOUT)
                );

                const imageUrl = await Promise.race([imagePromise, timeoutPromise]);
                await sendWhatsAppImage(chat, "✨ Here's your generated image!", imageUrl);

            } catch (error) {
                console.error(chalk.red('Image generation error:'), error);
                await chat.sendMessage("Sorry, I couldn't generate that image. Please try again.");
            } finally {
                activeImageGenerations.delete(chat.id._serialized);
            }
            return;
        }

        // Handle regular messages
        if (isGroupChat) {
            if (trimmedMessage.toLowerCase().startsWith(BOT_PREFIX)) {
                processedMessage = trimmedMessage.slice(BOT_PREFIX.length).trim();
                shouldProcess = processedMessage.length > 0;
            }
        } else {
            shouldProcess = true;
        }

        // Rest of your existing message handling code
        if (shouldProcess) {
            await processMessageWithQueue(chat, message, processedMessage);
        }

    } catch (error) {
        console.error(chalk.red('Message handling error:'), error);
        console.error(error.stack); // Add stack trace for better debugging
        handleConnectionState('ERROR');
    }
});

// Helper function to process messages through queue
async function processMessageWithQueue(chat, message, processedContent) {
    await chat.sendSeen();
    
    await messageQueue.addToQueue(chat, {
        ...message,
        body: processedContent
    }, async () => {
        const cacheKey = processedContent.toLowerCase().trim();
        if (messageCache.has(cacheKey)) {
            return messageCache.get(cacheKey);
        }

        try {
            const response = await makeApiCall(
                'https://api-okeymeta.vercel.app/api/ssailm/model/okeyai3.0-vanguard/okeyai',
                {
                    input: processedContent,
                    imgUrl: '',
                    APiKey: `okeymeta-${message.from}`
                }
            );

            if (response.data?.response) {
                const result = response.data.response.trim();
                messageCache.set(cacheKey, result);
                setTimeout(() => messageCache.delete(cacheKey), CACHE_DURATION);
                return result;
            }
            throw new Error('Invalid API response');
        } catch (error) {
            console.error(chalk.red('API Error:'), error.message);
            return "I'm having trouble processing your message right now. Please try again in a moment.";
        }
    });
}

// Initialize client with connection state handling
console.log('Starting WhatsApp client...\n');
client.initialize()
    .then(() => handleConnectionState('INITIALIZING'))
    .catch(async (error) => {
        console.error(chalk.red('Initialization failed:'), error);
        handleConnectionState('INITIALIZATION_FAILED');
        await reconnect();
    });

// Update the shutdown function to use serverInstance
const shutdown = async () => {
    console.log(chalk.yellow('\nShutting down...'));
    try {
        clearInterval(connectionCheckInterval);
        clearInterval(gcInterval);
        handleConnectionState('SHUTTING_DOWN');
        await client.destroy();
        if (serverInstance) {
            await new Promise(resolve => serverInstance.close(resolve));
            console.log(chalk.green('HTTP server closed.'));
        }
        console.log(chalk.green('Successfully logged out and cleaned up.'));
    } catch (error) {
        console.error(chalk.red('Error during shutdown:'), error);
        handleConnectionState('SHUTDOWN_ERROR');
    }
    process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);