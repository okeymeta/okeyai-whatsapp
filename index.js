import axios from 'axios';
import chalk from 'chalk';
import qrcode from 'qrcode-terminal';
import whatsappweb from 'whatsapp-web.js';
import fs from 'fs';
import { createRequire } from 'module'; // Add this line
import sharp from 'sharp'; // Add this line
import mongoose from 'mongoose';
import http from 'http'; // Add this line

const require = createRequire(import.meta.url); // Add this line
const Jimp = require('jimp'); // Direct require without destructuring

const { Client, LocalAuth, MessageMedia } = whatsappweb;

// Configure retry and rate limiting
const MAX_RETRIES = 3;
const RETRY_DELAY = 5000;
const MESSAGE_QUEUE_INTERVAL = 2000; // Time between messages (2 seconds)
const TYPING_DURATION = { MIN: 2000, MAX: 4000 }; // Random typing duration between 2-4 seconds
const MAX_CONCURRENT_CHATS = 15; // Maximum number of simultaneous chats
const DAILY_MESSAGE_LIMIT = 1000; // Maximum messages per day
const HOURLY_MESSAGE_LIMIT = 100; // Maximum messages per hour
const BOT_PREFIX = 'okeyai';
const IMAGE_COMMAND = 'imagine';
const IMAGE_TIMEOUT = 60000; // 60 seconds timeout for image generation

// Add these configurations at the top
const KEEP_ALIVE_INTERVAL = 280000; // 4.6 minutes
const MEMORY_CHECK_INTERVAL = 600000; // 10 minutes
const MAX_MEMORY_USAGE = 1024 * 1024 * 512; // 512MB

// Create sessions directory if it doesn't exist
const SESSION_DIR = './.wwebjs_auth';
if (!fs.existsSync(SESSION_DIR)) {
    fs.mkdirSync(SESSION_DIR, { recursive: true });
}

// MongoDB Connection
const MONGODB_URI = 'mongodb+srv://nwaozor:nwaozor@cluster0.rmvi7qm.mongodb.net/whatbot?retryWrites=true&w=majority';

mongoose.connect(MONGODB_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true
}).then(() => {
    console.log(chalk.green('Connected to MongoDB'));
}).catch(err => {
    console.error(chalk.red('MongoDB connection error:'), err);
});

// Create MongoDB Schema for WhatsApp session
const sessionSchema = new mongoose.Schema({
    sessionId: String,
    session: Object
});

const Session = mongoose.model('Session', sessionSchema);

// Custom MongoDB-based auth strategy
class MongoDBAuth extends LocalAuth {
    async beforeBrowserInitialize() {
        const sessionData = await Session.findOne({ sessionId: 'whatsapp-bot' });
        if (sessionData) {
            const sessionDir = './.wwebjs_auth/session';
            if (!fs.existsSync(sessionDir)) {
                fs.mkdirSync(sessionDir, { recursive: true });
            }
            fs.writeFileSync(
                `${sessionDir}/session.json`,
                JSON.stringify(sessionData.session)
            );
        }
    }

    async afterBrowserInitialize() {
        const sessionDir = './.wwebjs_auth/session';
        if (fs.existsSync(`${sessionDir}/session.json`)) {
            const sessionData = JSON.parse(
                fs.readFileSync(`${sessionDir}/session.json`, 'utf8')
            );
            await Session.findOneAndUpdate(
                { sessionId: 'whatsapp-bot' },
                { session: sessionData },
                { upsert: true }
            );
        }
    }
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

    canProcessMessage() {
        const now = Date.now();
        
        // Reset counters if a day has passed
        if (now - this.lastReset > 86400000) {
            this.resetDailyCount();
            this.resetHourlyCount();
            this.lastReset = now;
        }

        return this.activeChatCount < MAX_CONCURRENT_CHATS &&
               this.dailyMessages < DAILY_MESSAGE_LIMIT &&
               this.hourlyMessages < HOURLY_MESSAGE_LIMIT;
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

        // Limit to 50 messages per hour per user
        if (userCount >= 50) {
            return false;
        }

        // Ensure minimum 3 second gap between messages from same user
        if (now - lastMessage < 3000) {
            return false;
        }

        return true;
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
        const userQueue = this.queue.get(userId);
        
        while (userQueue.length > 0) {
            if (!this.canProcessMessage()) {
                // Wait and check again if limits are exceeded
                await new Promise(resolve => setTimeout(resolve, 5000));
                continue;
            }

            const { chat, message, handler } = userQueue[0];
            
            try {
                this.activeChatCount++;
                this.dailyMessages++;
                this.hourlyMessages++;
                
                // Show typing indicator with smart duration
                await chat.sendStateTyping();
                
                // Smarter typing duration based on message length
                const typingDuration = Math.min(
                    Math.max(message.body.length * 50, TYPING_DURATION.MIN),
                    TYPING_DURATION.MAX
                );
                await new Promise(resolve => setTimeout(resolve, typingDuration));
                
                // Process message with response splitting
                const result = await handler();
                if (result) {
                    const segments = splitMessage(result);
                    for (const segment of segments) {
                        await chat.sendStateTyping();
                        await new Promise(resolve => 
                            setTimeout(resolve, Math.min(segment.length * 50, 3000))
                        );
                        await client.sendMessage(message.from, segment);
                        // Add delay between segments
                        if (segments.length > 1) {
                            await new Promise(resolve => setTimeout(resolve, 1000));
                        }
                    }
                }
                
            } catch (error) {
                console.error(chalk.red(`Error processing message for user ${userId}:`), error);
                // Add error recovery logic
                if (error.message.includes('timeout')) {
                    await client.sendMessage(message.from, 
                        "I'm experiencing a temporary delay. Please try again in a moment.");
                }
            } finally {
                this.activeChatCount--;
                userQueue.shift(); // Remove processed message
                
                // Add delay between messages
                if (userQueue.length > 0) {
                    await new Promise(resolve => setTimeout(resolve, MESSAGE_QUEUE_INTERVAL));
                }
            }
        }
        
        // Clear queue for user if empty
        if (userQueue.length === 0) {
            this.queue.delete(userId);
            this.messageCount.delete(userId);
        }
    }
}

// Instantiate message queue
const messageQueue = new MessageQueue();

// Add port binding
const server = http.createServer((req, res) => {
    res.writeHead(200);
    res.end('WhatsApp bot is running');
});
server.listen(process.env.PORT || 3000, '0.0.0.0');

// Instantiate new WhatsApp client with persistent session
const client = new Client({
    authStrategy: new MongoDBAuth({
        clientId: 'whatsapp-bot',
        dataPath: SESSION_DIR
    }),
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--disable-extensions',
            '--disable-software-rasterizer',
            '--disable-web-security',
            '--aggressive-cache-discard',
            '--disable-cache',
            '--disable-application-cache',
            '--disable-offline-load-stale-cache',
            '--disk-cache-size=0',
            '--disable-backgrounding-occluded-windows',
            '--disable-breakpad',
            '--disable-component-extensions-with-background-pages',
            '--disable-features=TranslateUI,BlinkGenPropertyTrees',
            '--disable-ipc-flooding-protection',
            '--disable-renderer-backgrounding',
            '--enable-features=NetworkService,NetworkServiceInProcess',
            '--force-color-profile=srgb',
            '--metrics-recording-only',
            '--no-first-run',
            '--host-resolver-rules="MAP * ~NOTFOUND , EXCLUDE localhost"',
            '--ignore-certificate-errors',
            '--ignore-certificate-errors-spki-list',
            '--ignore-ssl-errors'
        ],
        defaultViewport: null,
        timeout: 0,
        browserWSEndpoint: null,
        userDataDir: './user_data'
    },
    restartOnAuthFail: true,
    takeoverOnConflict: true,
    takeoverTimeoutMs: 0,
    qrMaxRetries: 5,
    connectTimeoutMs: 0,
    authTimeoutMs: 0
});

// Connection status tracking
let isConnected = false;
let reconnectAttempts = 0;

// Connection state management
const handleConnectionState = (state) => {
    console.log(chalk.yellow(`Connection state: ${state}`));
    isConnected = state === 'CONNECTED';
};

// Enhanced reconnection logic
const reconnect = async () => {
    try {
        console.log(chalk.yellow('Attempting reconnection...'));
        
        // Proper cleanup
        if (client.pupPage) {
            await client.pupPage.close().catch(() => {});
        }
        if (client.pupBrowser) {
            await client.pupBrowser.close().catch(() => {});
        }
        
        // Wait before reconnecting
        await new Promise(resolve => setTimeout(resolve, 5000));
        
        // Clear any existing sessions
        try {
            fs.rmSync('./user_data', { recursive: true, force: true });
        } catch (err) {}
        
        // Initialize with fresh session
        await client.initialize();
        
        console.log(chalk.green('Reconnection successful'));
        reconnectAttempts = 0;
    } catch (error) {
        console.error(chalk.red('Reconnection failed:'), error);
        reconnectAttempts++;
        
        if (reconnectAttempts < MAX_RETRIES) {
            setTimeout(reconnect, RETRY_DELAY * reconnectAttempts);
        } else {
            console.log(chalk.red('Max retries reached, restarting process...'));
            process.exit(1); // Let process manager handle restart
        }
    }
};

// QR code event handler
client.on('qr', (qr) => {
    console.clear();
    console.log('\n1. Open WhatsApp on your phone\n2. Tap Menu or Settings and select WhatsApp Web\n3. Point your phone to this screen to capture the code\n');
    qrcode.generate(qr, { small: true });
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
    keepAlive();
    checkMemoryUsage();
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
        try {
            const response = await axios.get(
                `https://api-okeymeta.vercel.app/api/ssailm/model/okeyai3.0-vanguard/okeyai`,
                {
                    params: {
                        input: processedContent,
                        imgUrl: '',
                        APiKey: `okeymeta-${message.from}`
                    },
                    timeout: 90000
                }
            );

            if (response.data?.response) {
                return response.data.response.trim();
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

// Enhanced keep-alive mechanism
const keepAlive = () => {
    setInterval(async () => {
        try {
            const response = await axios.get(`http://localhost:${process.env.PORT || 3000}`);
            if (response.status !== 200) throw new Error('Health check failed');
            
            if (!isConnected) {
                await reconnect();
            }
        } catch (error) {
            console.error(chalk.red('Keep-alive error:'), error);
        }
    }, 30000);
};

// Add memory management
const checkMemoryUsage = () => {
    const used = process.memoryUsage();
    if (used.heapUsed > MAX_MEMORY_USAGE) {
        console.log(chalk.yellow('High memory usage detected, running garbage collection...'));
        if (global.gc) {
            global.gc();
        }
    }
};

// Add process error handlers to prevent crashes
process.on('uncaughtException', (err) => {
    console.error(chalk.red('Uncaught Exception:'), err);
});

process.on('unhandledRejection', (err) => {
    console.error(chalk.red('Unhandled Rejection:'), err);
});

// Add crash handling
process.on('SIGTERM', async () => {
    try {
        await client.destroy();
    } finally {
        process.exit(0);
    }
});

process.on('uncaughtException', async (err) => {
    console.error(chalk.red('Uncaught Exception:'), err);
    try {
        await client.destroy();
    } finally {
        process.exit(1);
    }
});