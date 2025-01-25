import axios from 'axios';
import chalk from 'chalk';
import qrcode from 'qrcode-terminal';
import whatsappweb from 'whatsapp-web.js';
import fs from 'fs';
import { createRequire } from 'module'; // Add this line
import sharp from 'sharp'; // Add this line
import http from 'http'; // Add this line

const require = createRequire(import.meta.url); // Add this line
const Jimp = require('jimp'); // Direct require without destructuring

const { Client, LocalAuth, MessageMedia } = whatsappweb;

// Configure retry and rate limiting
const MAX_RETRIES = 3;
const RETRY_DELAY = 5000;
const MESSAGE_QUEUE_INTERVAL = 1000; // Reduced from 2000 to 1000ms
const TYPING_DURATION = { MIN: 500, MAX: 1500 }; // Reduced from 2000-4000 to 500-1500ms
const MAX_CONCURRENT_CHATS = 15; // Maximum number of simultaneous chats
const DAILY_MESSAGE_LIMIT = 1000; // Maximum messages per day
const HOURLY_MESSAGE_LIMIT = 100; // Maximum messages per hour
const BOT_PREFIX = 'okeyai';
const IMAGE_COMMAND = 'imagine';
const IMAGE_TIMEOUT = 60000; // 60 seconds timeout for image generation

// Add new constants
const KEEPALIVE_INTERVAL = 10000; // More frequent pings (10 seconds)
const MEMORY_CHECK_INTERVAL = 300000; // 5 minutes
const MAX_MEMORY_USAGE = 1024 * 1024 * 512; // 512MB limit
const PORT = process.env.PORT || 10000; // Match Render's detected port
const PING_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`; // Add this line

// Add these new constants after existing constants
const HEALTH_CHECK_INTERVAL = 25 * 60 * 1000; // 25 minutes
const PING_INTERVAL = 4 * 60 * 1000; // 4 minutes
const AUTO_RESTART_INTERVAL = 12 * 60 * 60 * 1000; // 12 hours

// Add new constants after other constants
const IDLE_PING_INTERVAL = 25000; // 25 seconds
const ACTIVITY_SIMULATION_INTERVAL = 45000; // 45 seconds

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
    const timestamp = Date.now();
    const encodedPrompt = encodeURIComponent(prompt);
    const imageUrl = `https://image.pollinations.ai/prompt/${encodedPrompt}?model=flux-pro&nologo=true&enhance=true&private=true&seed=${timestamp}`;
    
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
                await new Promise(resolve => setTimeout(resolve, 2000)); // Reduced from 5000 to 2000ms
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
                    Math.max(message.body.length * 25, TYPING_DURATION.MIN), // Reduced multiplier from 50 to 25
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
                            setTimeout(resolve, Math.min(segment.length * 25, 1500)) // Reduced from 3000 to 1500ms
                        );
                        await client.sendMessage(message.from, segment);
                        // Add delay between segments
                        if (segments.length > 1) {
                            await new Promise(resolve => setTimeout(resolve, 500)); // Reduced from 1000 to 500ms
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

// Enhance client configuration
const client = new Client({
    authStrategy: new LocalAuth({
        clientId: 'whatsapp-bot',
        dataPath: SESSION_DIR
    }),
    puppeteer: {
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--disable-gpu',
            '--disable-extensions',
            '--disable-background-networking',
            '--disable-default-apps',
            '--disable-sync',
            '--no-zygote',
            '--single-process'
        ],
        headless: true,
        timeout: 0,
        defaultViewport: null
    },
    restartOnAuthFail: true,
    qrMaxRetries: 5,
    takeoverOnConflict: true,
    takeoverTimeoutMs: 0
});

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
            if (client.pupPage) {
                await client.pupPage.reload().catch(() => {});
            }
            await client.destroy();
            await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
            await client.initialize();
        } catch (error) {
            console.error(chalk.red('Reconnection failed:'), error);
            // Exponential backoff
            const delay = RETRY_DELAY * Math.pow(2, reconnectAttempts - 1);
            setTimeout(reconnect, delay);
        }
    } else {
        console.error(chalk.red('Max reconnection attempts reached. Forcing restart...'));
        process.exit(1);
    }
};

// Add keepalive and memory management functions
const setupKeepAlive = () => {
    // Aggressive keep-alive strategy
    setInterval(async () => {
        if (isConnected) {
            try {
                // Send WhatsApp presence
                await client.sendPresenceAvailable();
                
                // Ping our own endpoint
                await pingExternalUrl();
                
                // Force browser activity
                if (client.pupPage) {
                    await client.pupPage.evaluate(() => {
                        document.title = `Active - ${Date.now()}`;
                        window.dispatchEvent(new Event('focus'));
                        window.dispatchEvent(new Event('mousemove'));
                    });
                }
            } catch (error) {
                console.log(chalk.yellow('Keep-alive cycle error (non-critical):', error.message));
            }
        }
    }, KEEPALIVE_INTERVAL);
};

const setupMemoryManagement = () => {
    setInterval(() => {
        const memoryUsage = process.memoryUsage().heapUsed;
        if (memoryUsage > MAX_MEMORY_USAGE) {
            console.log(chalk.yellow('High memory usage detected, running garbage collection...'));
            try {
                global.gc();
            } catch (e) {
                console.log(chalk.yellow('Manual garbage collection not available'));
            }
        }
    }, MEMORY_CHECK_INTERVAL);
};

// Add this function after setupMemoryManagement
const setupHealthCheck = () => {
    // Periodically hit our own HTTP endpoint to keep the service active
    setInterval(() => {
        try {
            http.get(`http://0.0.0.0:${PORT}`, (res) => {
                if (res.statusCode === 200) {
                    console.log(chalk.blue('Health check passed'));
                }
            }).on('error', (err) => {
                console.error(chalk.red('Health check failed:', err));
            });
        } catch (error) {
            console.error(chalk.red('Health check error:', error));
        }
    }, HEALTH_CHECK_INTERVAL);

    // Periodic ping to keep connection alive
    setInterval(() => {
        if (isConnected && client.pupPage) {
            client.sendPresenceAvailable()
                .catch(err => console.error(chalk.yellow('Presence update failed:', err)));
        }
    }, PING_INTERVAL);

    // Auto-restart to prevent memory leaks and keep fresh
    setInterval(() => {
        console.log(chalk.yellow('Performing scheduled restart...'));
        process.exit(0); // Process manager will restart
    }, AUTO_RESTART_INTERVAL);
};

// Add this function after other utility functions
const simulateActivity = async () => {
    if (isConnected && client.pupPage) {
        try {
            // Simulate minimal activity to keep connection alive
            await client.sendPresenceAvailable();
            await client.pupPage.evaluate(() => console.log('keep-alive ping'));
            
            // Force minimal browser activity
            if (client.pupPage) {
                await client.pupPage.evaluate(() => {
                    window.dispatchEvent(new Event('focus'));
                    document.dispatchEvent(new Event('mousemove'));
                });
            }
        } catch (error) {
            console.log(chalk.yellow('Activity simulation error (non-critical):'), error.message);
        }
    }
};

// Add this function to perform external ping
const pingExternalUrl = async () => {
    try {
        const response = await axios.get(PING_URL);
        return response.status === 200;
    } catch (error) {
        return false;
    }
};

// Modify the HTTP server to include a more robust health check
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        status: 'ok',
        timestamp: Date.now()
    }));
});

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
    
    return messageQueue.addToQueue(chat, {
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
                    timeout: 30000, // Reduced timeout
                    headers: {
                        'Keep-Alive': 'timeout=30, max=1000'
                    }
                }
            );

            return response.data?.response?.trim() || 
                   "I apologize, but I couldn't process that request properly.";
        } catch (error) {
            console.error(chalk.red('API Error:'), error.message);
            return "I'm having trouble processing your message. Please try again.";
        }
    });
}

// Initialize client with connection state handling
console.log('Starting WhatsApp client...\n');
let serverStarted = false;

client.initialize()
    .then(() => {
        handleConnectionState('INITIALIZING');
        setupKeepAlive();
        setupMemoryManagement();
        setupHealthCheck(); // Add this line
        
        // Only start server if not already started
        if (!serverStarted) {
            server.listen(PORT, '0.0.0.0', () => {
                console.log(chalk.blue(`Server active on port ${PORT}`));
                serverStarted = true;
            });
        }
        
        // Set up persistent ping
        setInterval(pingExternalUrl, KEEPALIVE_INTERVAL);
    })
    .catch(async (error) => {
        console.error(chalk.red('Initialization failed:'), error);
        handleConnectionState('INITIALIZATION_FAILED');
        await reconnect();
    });

// Graceful shutdown
const shutdown = async () => {
    console.log(chalk.yellow('\nShutting down...'));
    try {
        handleConnectionState('SHUTTING_DOWN');
        await client.destroy();
        if (serverStarted) {
            await new Promise(resolve => server.close(resolve));
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

// Add these process error handlers at the end of the file
process.on('uncaughtException', (err) => {
    console.error(chalk.red('Uncaught Exception:'), err);
    // Allow the process to restart cleanly
    setTimeout(() => process.exit(1), 1000);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error(chalk.red('Unhandled Rejection at:'), promise, 'reason:', reason);
    // Continue running but log the error
});

// Add this at the end of the file
if (process.env.NODE_ENV === 'production') {
    // Prevent Render from killing the process
    setInterval(() => {
        console.log('Service heartbeat:', new Date().toISOString());
    }, 60000);
}