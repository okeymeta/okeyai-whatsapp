import axios from 'axios';
import chalk from 'chalk';
import qrcode from 'qrcode-terminal';
import whatsappweb from 'whatsapp-web.js';
import fs from 'fs';
import { createRequire } from 'module'; // Add this line
import sharp from 'sharp'; // Add this line
import http from 'http'; // Add this line
import mongoose from 'mongoose'; // Add this line
import { MongoStore } from 'wwebjs-mongo'; // Add this line
import { EventEmitter } from 'events'; // Add this line

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
const KEEPALIVE_INTERVAL = 1000; // More frequent keep-alive (1 second)
const MEMORY_CHECK_INTERVAL = 300000; // 5 minutes
const MAX_MEMORY_USAGE = 1024 * 1024 * 512; // 512MB limit
const PORT = process.env.PORT || 10000; // Match Render's detected port
const PING_URL = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`; // Add this line

// Add these new constants after existing constants
const HEALTH_CHECK_INTERVAL = 25 * 60 * 1000; // 25 minutes
const PING_INTERVAL = 4 * 60 * 1000; // 4 minutes
const AUTO_RESTART_INTERVAL = 24 * 60 * 60 * 1000; // Extend to 24 hours

// Add new constants after other constants
const WHATSAPP_REFRESH_INTERVAL = 30 * 60 * 1000; // 30 minutes
const PRESENCE_REFRESH_INTERVAL = 15000; // 15 seconds
const CONNECTION_RECOVERY_ATTEMPTS = 3;

// Update constants
const HEARTBEAT_INTERVAL = 10000; // 10 seconds for heartbeat
const BROWSER_CHECK_INTERVAL = 3000; // Check browser every 3 seconds
const CONNECTION_CHECK_INTERVAL = 5000; // Reduce to 5 seconds
const MAX_RESPONSE_TIME = 15000; // Maximum response time threshold
const RESTART_THRESHOLD = 60000; // Increase to 60 seconds

// Update these constants at the top
const RECONNECT_DELAY = 1000; // More aggressive reconnect
const API_RETRY_ATTEMPTS = 3;  // Add this constant
const MAX_LISTENERS = 25; // Increase max listeners limit

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

// Add MongoDB connection constants
const MONGODB_URI = process.env.MONGODB_URI || 'your_mongodb_atlas_uri_here';
const DB_NAME = 'whatbot';
const COLLECTION_NAME = 'sessions';

// Add MongoDB connection and store setup
let store;
mongoose.connect(MONGODB_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
}).then(() => {
    console.log(chalk.green('Connected to MongoDB Atlas'));
    store = new MongoStore({ mongoose: mongoose });
});

// Enhance client configuration
const client = new Client({
    authStrategy: new LocalAuth({
        clientId: 'whatsapp-bot',
        dataPath: SESSION_DIR,
        store: store
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
            '--single-process',
            '--aggressive-cache-discard', // Add this line
            '--disable-cache', // Add this line
            '--disable-application-cache', // Add this line
            '--disable-offline-load-stale-cache', // Add this line
            '--disk-cache-size=0', // Add this line
            '--disable-web-security',
            '--ignore-certificate-errors',
            '--ignore-certificate-errors-spki-list',
            '--ignore-ssl-errors'
        ],
        headless: true,
        timeout: 0,
        defaultViewport: null,
        handleSIGINT: false,
        handleSIGTERM: false,
        handleSIGHUP: false
    },
    restartOnAuthFail: true,
    qrMaxRetries: 5,
    takeoverOnConflict: true,
    takeoverTimeoutMs: 0,
    webVersionCache: {
        type: 'local',
        path: './.wwebjs_cache'
    }
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
    let attempts = 0;
    
    while (attempts < CONNECTION_RECOVERY_ATTEMPTS) {
        try {
            attempts++;
            
            // Try to refresh the page first
            if (client.pupPage) {
                await refreshWhatsAppPage();
                if (await safePresenceUpdate()) {
                    console.log(chalk.green('Connection recovered successfully'));
                    return;
                }
            }

            // If refresh fails, try full reconnect
            await client.initialize();
            return;
        } catch (error) {
            console.log(chalk.yellow(`Reconnection attempt ${attempts} failed`));
            await new Promise(resolve => setTimeout(resolve, 5000));
        }
    }
    
    // Keep the connection alive even if reconnect fails
    isConnected = true;
};

// Add keepalive and memory management functions
const setupKeepAlive = () => {
    // Regular presence updates
    setInterval(async () => {
        if (isConnected) {
            await safePresenceUpdate().catch(() => {});
        }
    }, PRESENCE_REFRESH_INTERVAL);

    // Periodic WhatsApp refresh
    setInterval(async () => {
        if (isConnected) {
            await refreshWhatsAppPage();
        }
    }, WHATSAPP_REFRESH_INTERVAL);
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
    setInterval(() => {
        try {
            axios.get(`http://localhost:${PORT}`)
                .then(() => console.log(chalk.blue('Health check passed')))
                .catch(() => {});
        } catch (error) {
            // Ignore errors
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
        const url = `http://localhost:${PORT}`;
        const response = await axios.get(url, {
            timeout: 5000,
            headers: {
                'Connection': 'keep-alive'
            }
        });
        return response.status === 200;
    } catch (error) {
        return false;
    }
};

// Add new keepalive function
const maintainConnection = () => {
    let lastSuccessfulPing = Date.now();
    
    // Aggressive connection maintenance
    setInterval(async () => {
        if (isConnected) {
            try {
                await Promise.all([
                    client.sendPresenceAvailable(),
                    client.pupPage?.evaluate(() => {
                        document.title = `Active ${Date.now()}`;
                        window.dispatchEvent(new Event('focus'));
                    }),
                    axios.get(`http://localhost:${PORT}/ping`)
                ]);
                
                lastSuccessfulPing = Date.now();
            } catch (error) {
                const timeSinceLastPing = Date.now() - lastSuccessfulPing;
                if (timeSinceLastPing > 30000) { // 30 seconds without successful ping
                    console.log(chalk.yellow('Connection appears stale, forcing refresh...'));
                    await reconnect();
                }
            }
        }
    }, KEEPALIVE_INTERVAL);

    // Additional heartbeat
    setInterval(() => {
        if (isConnected) {
            http.get(`http://0.0.0.0:${PORT}`).end();
            console.log('Heartbeat:', new Date().toISOString());
        }
    }, 1000); // Every second
};

// Add new function for browser monitoring
const setupBrowserMonitoring = () => {
    let browserRestartCount = 0;
    
    setInterval(async () => {
        if (isConnected) {
            try {
                if (!client.pupPage || !client.pupBrowser || !await client.pupPage.evaluate(() => true).catch(() => false)) {
                    console.log(chalk.yellow('Browser health check failed, refreshing connection...'));
                    browserRestartCount++;
                    
                    if (browserRestartCount > 3) {
                        process.exit(1); // Force complete restart if too many browser restarts
                    }
                    
                    await reconnect();
                } else {
                    browserRestartCount = 0; // Reset counter on successful check
                }
            } catch (error) {
                console.log(chalk.yellow('Browser check error:', error.message));
            }
        }
    }, BROWSER_CHECK_INTERVAL);
};

// Add this new connection monitoring function
const monitorConnection = () => {
    let lastActivity = Date.now();
    
    setInterval(async () => {
        const inactiveTime = Date.now() - lastActivity;
        
        if (isConnected && client.pupPage) {
            try {
                // Verify connection is truly alive
                const isAlive = await client.pupPage.evaluate(() => navigator.onLine);
                if (isAlive) {
                    lastActivity = Date.now();
                } else {
                    throw new Error('Browser reports offline');
                }
            } catch (error) {
                console.log(chalk.yellow('Connection check failed:', error.message));
                if (inactiveTime > RESTART_THRESHOLD) {
                    console.log(chalk.red('Connection dead, forcing restart...'));
                    await reconnect();
                }
            }
        }
    }, CONNECTION_CHECK_INTERVAL);

    // Add active keep-alive pings
    setInterval(async () => {
        if (isConnected && client.pupPage) {
            try {
                await client.sendPresenceAvailable();
                await client.pupPage.evaluate(() => {
                    window.focus();
                    document.dispatchEvent(new Event('mousemove'));
                });
                lastActivity = Date.now();
            } catch (error) {
                console.log(chalk.yellow('Keep-alive failed:', error.message));
            }
        }
    }, KEEPALIVE_INTERVAL);
};

// Add new persistent connection function
const setupPersistentConnection = () => {
    let keepAliveInterval;
    
    const startKeepAlive = () => {
        if (keepAliveInterval) clearInterval(keepAliveInterval);
        
        keepAliveInterval = setInterval(async () => {
            if (isConnected && client.pupPage) {
                try {
                    await Promise.all([
                        client.sendPresenceAvailable(),
                        client.pupPage.evaluate(() => {
                            window.focus();
                            document.title = `Active ${Date.now()}`;
                            window.dispatchEvent(new Event('focus'));
                            document.dispatchEvent(new Event('mousemove'));
                        }),
                        pingExternalUrl()
                    ]);
                } catch (error) {
                    // Ignore errors but keep running
                }
            }
        }, 1000); // Run every second
    };

    startKeepAlive();
    
    // Restart keep-alive if it stops
    setInterval(() => {
        if (!keepAliveInterval) startKeepAlive();
    }, 5000);
};

// Add this new presence update function
const safePresenceUpdate = async () => {
    if (!client.pupPage) return false;
    
    try {
        // First try the Store method
        const storePresence = await client.pupPage.evaluate(() => {
            if (window.Store && window.Store.PresenceUtils) {
                window.Store.PresenceUtils.sendPresenceAvailable();
                return true;
            }
            return false;
        });

        if (storePresence) return true;

        // Fallback to client method
        await client.sendPresenceAvailable();
        return true;
    } catch (error) {
        // If presence fails, try to refresh WhatsApp
        await refreshWhatsAppPage();
        return false;
    }
};

// Add this function near the top
const setupEventEmitterDefaults = () => {
    // Increase max listeners globally
    EventEmitter.defaultMaxListeners = MAX_LISTENERS;
    // Increase for process specifically
    process.setMaxListeners(MAX_LISTENERS);
};

// Add new WhatsApp page refresh function
const refreshWhatsAppPage = async () => {
    if (!client.pupPage) return;
    
    try {
        // Store session data
        const sessionData = await client.pupPage.evaluate(() => {
            return localStorage.getItem('WAWebSessionData');
        });

        // Refresh the page
        await client.pupPage.reload({ waitUntil: 'networkidle0', timeout: 60000 });

        // Restore session after reload
        if (sessionData) {
            await client.pupPage.evaluate((data) => {
                localStorage.setItem('WAWebSessionData', data);
            }, sessionData);
        }

        // Ensure WhatsApp is ready
        await client.pupPage.waitForFunction(() => {
            return window.Store && window.Store.PresenceUtils;
        }, { timeout: 30000 });

        console.log(chalk.green('WhatsApp Web refreshed successfully'));
        isConnected = true;
    } catch (error) {
        console.log(chalk.yellow('WhatsApp refresh failed, attempting recovery...'));
        await reconnect();
    }
};

// Update the server creation
const server = http.createServer((req, res) => {
    res.writeHead(200, { 
        'Content-Type': 'application/json',
        'Connection': 'keep-alive',
        'Keep-Alive': 'timeout=120'
    });
    res.end(JSON.stringify({
        status: 'ok',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        isConnected
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

// Add this new recovery function
const handleConnectionError = async (error) => {
    console.log(chalk.yellow('Connection error detected:', error.message));
    
    if (error.code === 'ECONNRESET' || error.syscall === 'read') {
        console.log(chalk.blue('Attempting to recover from connection reset...'));
        try {
            // Keep the client alive but attempt to refresh the connection
            await client.pupPage?.evaluate(() => {
                window.location.reload();
            }).catch(() => {});
            
            // Force reconnection without full restart
            await client.sendPresenceAvailable().catch(() => {});
            
            // Mark as connected to keep bot responding
            isConnected = true;
            handleConnectionState('RECOVERED');
        } catch (recoveryError) {
            console.log(chalk.yellow('Recovery attempt failed, continuing anyway'));
            // Keep running even if recovery fails
            isConnected = true;
        }
    }
};

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
            // Wrap in error handler to prevent crashes
            try {
                await processMessageWithQueue(chat, message, processedMessage);
            } catch (error) {
                handleConnectionError(error);
                // Still try to process the message
                await processMessageWithQueue(chat, message, processedMessage);
            }
        }

    } catch (error) {
        console.error(chalk.red('Message handling error:'), error);
        console.error(error.stack); // Add stack trace for better debugging
        handleConnectionError(error);
    }
});

// Helper function to process messages through queue
async function processMessageWithQueue(chat, message, processedContent) {
    await chat.sendSeen();
    
    return messageQueue.addToQueue(chat, {
        ...message,
        body: processedContent
    }, async () => {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), MAX_RESPONSE_TIME);

        const makeApiCall = async (attempt = 1) => {
            try {
                const response = await axios.get(
                    `https://api-okeymeta.vercel.app/api/ssailm/model/okeyai3.0-vanguard/okeyai`,
                    {
                        params: {
                            input: processedContent,
                            imgUrl: '',
                            APiKey: `okeymeta-${message.from}`
                        },
                        timeout: MAX_RESPONSE_TIME,
                        headers: {
                            'Keep-Alive': 'timeout=60, max=1000',
                            'Connection': 'keep-alive',
                            'Cache-Control': 'no-cache',
                            'Pragma': 'no-cache'
                        },
                        responseType: 'json',
                        // Add retry configuration
                        validateStatus: status => status < 500,
                        maxRedirects: 5,
                        maxContentLength: 50 * 1024 * 1024 // 50MB
                    }
                );
                return response.data?.response?.trim();
            } catch (error) {
                if (attempt < API_RETRY_ATTEMPTS) {
                    await new Promise(resolve => setTimeout(resolve, 1000));
                    return makeApiCall(attempt + 1);
                }
                throw error;
            }
        };

        try {
            // Start typing indicator immediately
            chat.sendStateTyping().catch(() => {});

            // Make API call with optimized settings
            const response = await makeApiCall();

            clearTimeout(timeoutId);
            return response;
        } catch (error) {
            clearTimeout(timeoutId);
            console.error(chalk.red('API Error:'), error.message);
            throw error; // Let the queue handler deal with retries
        }
    });
}

// Initialize client with connection state handling
console.log('Starting WhatsApp client...\n');

// Start the server first
server.listen(PORT, '0.0.0.0', async () => {
    console.log(chalk.blue(`Server started on port ${PORT}`));
    
    try {
        setupEventEmitterDefaults(); // Add this line
        
        // Initialize WhatsApp client after server is running
        await client.initialize();
        handleConnectionState('INITIALIZING');
        setupKeepAlive();
        setupMemoryManagement();
        setupHealthCheck();
        maintainConnection(); // Add the new aggressive keep-alive
        setupBrowserMonitoring(); // Add browser monitoring
        monitorConnection(); // Add the new monitoring
        setupPersistentConnection(); // Add new persistent connection
        
        // Prevent any automatic shutdowns
        process.on('SIGTERM', () => {
            console.log('Received SIGTERM - Ignoring to stay alive');
        });
        
        process.on('SIGINT', () => {
            console.log('Received SIGINT - Ignoring to stay alive');
        });
        
    } catch (error) {
        console.error(chalk.red('Initialization failed:'), error);
        handleConnectionState('INITIALIZATION_FAILED');
        await reconnect();
    }
});

// Graceful shutdown
const shutdown = async (forceRestart = false) => {
    // Always prevent shutdown in production
    if (process.env.NODE_ENV === 'production') {
        console.log(chalk.blue('Shutdown prevented in production'));
        return;
    }
    
    // Only proceed with shutdown if explicitly forced
    if (!forceRestart) {
        console.log(chalk.blue('Shutdown prevented - bot must stay alive'));
        return;
    }

    // Prevent multiple shutdown attempts
    if (global.isShuttingDown) return;
    global.isShuttingDown = true;

    console.log(chalk.yellow('\nShutdown requested...'));
    
    // Only actually shutdown if it's a real termination request
    if (!forceRestart && process.env.NODE_ENV === 'production') {
        console.log(chalk.blue('Production environment detected, keeping alive...'));
        global.isShuttingDown = false;
        return;
    }

    try {
        handleConnectionState('SHUTTING_DOWN');
        
        // Clean up browser
        if (client.pupPage) {
            await client.pupPage.close().catch(() => {});
        }
        if (client.pupBrowser) {
            await client.pupBrowser.close().catch(() => {});
        }
        
        await client.destroy();
        
        // Close server properly with a promise
        await new Promise((resolve) => {
            if (server.listening) {
                server.close(() => resolve());
            } else {
                resolve();
            }
        });
        
        console.log(chalk.green('Successfully cleaned up.'));
    } catch (error) {
        console.error(chalk.red('Error during shutdown:'), error);
        handleConnectionState('SHUTDOWN_ERROR');
    } finally {
        global.isShuttingDown = false;
    }
    
    if (forceRestart) {
        process.exit(1); // Force restart
    }
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Add these process error handlers at the end of the file
process.on('uncaughtException', async (err) => {
    console.error(chalk.red('Uncaught Exception:'), err);
    await handleConnectionError(err);
    // Don't exit, try to keep running
});

process.on('unhandledRejection', async (reason, promise) => {
    console.error(chalk.red('Unhandled Rejection at:'), promise, 'reason:', reason);
    await handleConnectionError(reason);
    // Don't exit, try to keep running
});

// Remove the old production heartbeat at the end of the file and replace with this:
if (process.env.NODE_ENV === 'production') {
    process.stdin.resume(); // Keep process running
    process.on('SIGTERM', () => {
        console.log('Received SIGTERM, keeping alive');
    });
}