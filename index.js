import axios from 'axios';
import chalk from 'chalk';
import qrcode from 'qrcode-terminal';
import whatsappweb from 'whatsapp-web.js';
import { createRequire } from 'module';
import sharp from 'sharp';
import { createClient } from '@supabase/supabase-js';
import fs from 'fs/promises';
import path from 'path';

const require = createRequire(import.meta.url);
const Jimp = require('jimp');

const { Client, MessageMedia, RemoteAuth } = whatsappweb;

// Hardcoded Supabase credentials
const supabaseUrl = 'https://wuuggutodctswfhsdiux.supabase.co';
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Ind1dWdndXRvZGN0c3dmaHNkaXV4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDY5MDA3MDAsImV4cCI6MjA2MjQ3NjcwMH0.atPd30isC9n3Jph1JJoE3WihrZk8BQ9ZSZi0eYalGJY';
if (!supabaseUrl || !supabaseKey) {
    console.error(chalk.red('Supabase URL or key is not configured'));
    process.exit(1);
}
const supabase = createClient(supabaseUrl, supabaseKey);

// Supabase bucket name
const BUCKET_NAME = 'whatsapp-sessions';

// Configure retry and rate limiting
const MAX_RETRIES = 3;
const RETRY_DELAY = 5000;
const MESSAGE_QUEUE_INTERVAL = 2000;
const TYPING_DURATION = { MIN: 2000, MAX: 4000 };
const MAX_CONCURRENT_CHATS = 15;
const DAILY_MESSAGE_LIMIT = 1000;
const HOURLY_MESSAGE_LIMIT = 100;
const BOT_PREFIX = 'okeyai';
const IMAGE_COMMAND = 'imagine';
const IMAGE_TIMEOUT = 60000;

// Custom SupabaseAuth strategy
class SupabaseAuth extends RemoteAuth {
    constructor(clientId) {
        // Define the store object that implements the required methods
        const store = {
            save: async ({ session }) => {
                try {
                    const sessionFiles = Object.entries(session).map(([key, value]) => ({
                        name: `${key}.json`,
                        data: Buffer.from(JSON.stringify(value)),
                    }));

                    for (const file of sessionFiles) {
                        const filePath = `${this.sessionPath}/${file.name}`;
                        await supabase.storage
                            .from(BUCKET_NAME)
                            .upload(filePath, file.data, {
                                contentType: 'application/json',
                                upsert: true,
                            });
                    }
                    console.log(chalk.green('Session saved to Supabase'));
                } catch (error) {
                    console.error(chalk.red('Error saving session to Supabase:'), error);
                    throw error;
                }
            },
            extract: async () => {
                try {
                    const { data, error } = await supabase.storage
                        .from(BUCKET_NAME)
                        .list(this.sessionPath);
                    
                    if (error) throw error;
                    if (!data || data.length === 0) return null;

                    const session = {};
                    for (const file of data) {
                        const { data: fileData, error: fileError } = await supabase.storage
                            .from(BUCKET_NAME)
                            .download(`${this.sessionPath}/${file.name}`);
                        
                        if (fileError) throw fileError;
                        
                        const text = await fileData.text();
                        const key = file.name.replace('.json', '');
                        session[key] = JSON.parse(text);
                    }
                    console.log(chalk.green('Session loaded from Supabase'));
                    return session;
                } catch (error) {
                    console.error(chalk.red('Error loading session from Supabase:'), error);
                    return null;
                }
            },
            remove: async () => {
                try {
                    const { data, error } = await supabase.storage
                        .from(BUCKET_NAME)
                        .list(this.sessionPath);
                    
                    if (error) throw error;
                    
                    const filePaths = data.map(file => `${this.sessionPath}/${file.name}`);
                    if (filePaths.length > 0) {
                        await supabase.storage
                            .from(BUCKET_NAME)
                            .remove(filePaths);
                        console.log(chalk.green('Session cleared from Supabase'));
                    }
                } catch (error) {
                    console.error(chalk.red('Error clearing session from Supabase:'), error);
                }
            },
            sessionExists: async () => {
                try {
                    const { data, error } = await supabase.storage
                        .from(BUCKET_NAME)
                        .list(this.sessionPath);
                    
                    if (error) throw error;
                    return data && data.length > 0;
                } catch (error) {
                    console.error(chalk.red('Error checking session existence in Supabase:'), error);
                    return false;
                }
            }
        };

        // Pass the configuration object with clientId, backupSyncIntervalMs, store, and dataPath
        super({
            clientId: clientId,
            backupSyncIntervalMs: 0, // Disable automatic backups
            store: store,
            dataPath: process.env.LOCAL_PATH || '/tmp'
        });

        this.clientId = clientId;
        this.sessionPath = `sessions/${clientId}`;
    }

    // Override ZIP-related methods to prevent ZIP operations
    async afterLoad() {
        return; // Do nothing, skip ZIP backup
    }

    async beforeSave() {
        return; // Do nothing, skip ZIP preparation
    }

    async writeBackupFile() {
        return; // Do nothing, skip ZIP writing
    }

    async readBackupFile() {
        return null; // Return null to skip ZIP reading
    }

    async saveSession(session) {
        await this.store.save({ session });
    }

    async loadSession() {
        return await this.store.extract();
    }

    async clearSession() {
        await this.store.remove();
    }
}

// Utility functions
const splitMessage = (text) => {
    const MAX_LENGTH = 990;
    if (text.length <= MAX_LENGTH) return [text];

    const segments = [];
    let currentSegment = "";

    const sentences = text.split(/(?<=[.!?])\s+/);

    for (const sentence of sentences) {
        if ((currentSegment + sentence).length <= MAX_LENGTH) {
            currentSegment += (currentSegment ? " " : "") + sentence;
        } else {
            if (currentSegment) segments.push(currentSegment);

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

    return segments.map((segment, index) => 
        `${segment.trim()}${index < segments.length - 1 ? ' (continued...)' : ''}`
    );
};

const generateImage = async (prompt) => {
    const encodedPrompt = encodeURIComponent(prompt);
    const imageUrl = `https://image.pollinations.ai/prompt/${encodedPrompt}?&model=flux-pro&nologo=true&enhance=true&private=true`;
    await axios.head(imageUrl);
    return imageUrl;
};

async function addWatermark(imageBuffer) {
    try {
        const watermarkText = "OkeyMeta AI";
        const svgText = `
            <svg width="200" height="50">
                <rect x="0" y="0" width="200" height="50" fill="rgba(0,0,0,0.5)"/>
                <text x="10" y="35" font-family="Arial" font-size="24" fill="white">${watermarkText}</text>
            </svg>
        `;
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
        throw error;
    }
}

async function sendWhatsAppImage(chat, caption, imageUrl) {
    try {
        const response = await axios.get(imageUrl, { 
            responseType: 'arraybuffer',
            timeout: 30000
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
        this.queue = new Map();
        this.messageCount = new Map();
        this.activeChatCount = 0;
        this.dailyMessages = 0;
        this.hourlyMessages = 0;
        this.lastReset = Date.now();
        this.userLastMessage = new Map();
        this.userMessageCount = new Map();
        setInterval(() => this.resetHourlyCount(), 3600000);
        setInterval(() => this.resetDailyCount(), 86400000);
    }

    resetHourlyCount() {
        this.hourlyMessages = 0;
    }

    resetDailyCount() {
        this.dailyMessages = 0;
    }

    canProcessMessage() {
        const now = Date.now();
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
        if (now - lastMessage > 3600000) {
            this.userMessageCount.set(userId, 0);
            return true;
        }
        if (userCount >= 50) return false;
        if (now - lastMessage < 3000) return false;
        return true;
    }

    async addToQueue(chat, message, handler) {
        const userId = message.from;
        await chat.sendSeen();
        if (!await this.checkUserRateLimit(userId)) {
            await client.sendMessage(userId, 
                "Please wait a moment before sending more messages. This helps maintain service quality.");
            return;
        }
        this.userLastMessage.set(userId, Date.now());
        this.userMessageCount.set(userId, (this.userMessageCount.get(userId) || 0) + 1);
        if (!this.queue.has(userId)) {
            this.queue.set(userId, []);
            this.messageCount.set(userId, 0);
        }
        this.queue.get(userId).push({ chat, message, handler });
        if (this.queue.get(userId).length === 1) {
            this.processQueue(userId);
        }
    }

    async processQueue(userId) {
        const userQueue = this.queue.get(userId);
        while (userQueue.length > 0) {
            if (!this.canProcessMessage()) {
                await new Promise(resolve => setTimeout(resolve, 5000));
                continue;
            }
            const { chat, message, handler } = userQueue[0];
            try {
                this.activeChatCount++;
                this.dailyMessages++;
                this.hourlyMessages++;
                await chat.sendStateTyping();
                const typingDuration = Math.min(
                    Math.max(message.body.length * 50, TYPING_DURATION.MIN),
                    TYPING_DURATION.MAX
                );
                await new Promise(resolve => setTimeout(resolve, typingDuration));
                const result = await handler();
                if (result) {
                    const segments = splitMessage(result);
                    for (const segment of segments) {
                        await chat.sendStateTyping();
                        await new Promise(resolve => 
                            setTimeout(resolve, Math.min(segment.length * 50, 3000))
                        );
                        await client.sendMessage(message.from, segment);
                        if (segments.length > 1) {
                            await new Promise(resolve => setTimeout(resolve, 1000));
                        }
                    }
                }
            } catch (error) {
                console.error(chalk.red(`Error processing message for user ${userId}:`), error);
                if (error.message.includes('timeout')) {
                    await client.sendMessage(message.from, 
                        "I'm experiencing a temporary delay. Please try again in a moment.");
                }
            } finally {
                this.activeChatCount--;
                userQueue.shift();
                if (userQueue.length > 0) {
                    await new Promise(resolve => setTimeout(resolve, MESSAGE_QUEUE_INTERVAL));
                }
            }
        }
        if (userQueue.length === 0) {
            this.queue.delete(userId);
            this.messageCount.delete(userId);
        }
    }
}

// Instantiate message queue
const messageQueue = new MessageQueue();
const activeImageGenerations = new Map();

// Instantiate WhatsApp client with SupabaseAuth
const client = new Client({
    authStrategy: new SupabaseAuth('whatsapp-bot'),
    puppeteer: {
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
        headless: true
    },
    restartOnAuthFail: true
});

// Connection status tracking
let isConnected = false;
let reconnectAttempts = 0;

const handleConnectionState = (state) => {
    console.log(chalk.yellow(`Connection state: ${state}`));
    isConnected = state === 'CONNECTED';
};

// Add error event listener to handle unhandled errors
process.on('uncaughtException', (error) => {
    console.error(chalk.red('Uncaught Exception:'), error);
    if (error.code === 'ENOENT' && error.path.includes('RemoteAuth-whatsapp-bot.zip')) {
        console.warn(chalk.yellow('Ignoring ENOENT error for RemoteAuth ZIP file. Using Supabase session.'));
    } else {
        process.exit(1); // Exit only for non-ENOENT errors
    }
});

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

client.on('qr', (qr) => {
    console.clear();
    console.log('\n1. Open WhatsApp on your phone\n2. Tap Menu or Settings and select WhatsApp Web\n3. Point your phone to this screen to capture the code\n');
    qrcode.generate(qr, { small: true });
});

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

client.on('ready', () => {
    isConnected = true;
    handleConnectionState('CONNECTED');
    console.log(chalk.green('OkeyAI is ready and connected!\n'));
    console.log(chalk.greenBright('OkeyAI activated. Listening for messages...\n'));
    global.botStartTime = Date.now();
});

client.on('disconnected', async (reason) => {
    console.log(chalk.red('Client disconnected:'), reason);
    isConnected = false;
    handleConnectionState('DISCONNECTED');
    await reconnect();
});

client.on('message', async (message) => {
    if (!isConnected) return;
    try {
        const chat = await message.getChat();
        const trimmedMessage = message.body.trim();
        if (!trimmedMessage) return;
        const isGroupChat = chat.id._serialized.endsWith('@g.us');
        let processedMessage = trimmedMessage;
        let shouldProcess = false;
        let isImageRequest = false;
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
            if (activeImageGenerations.has(chat.id._serialized)) {
                await chat.sendMessage("I'm already generating an image for you. Please wait...");
                return;
            }
            try {
                activeImageGenerations.set(chat.id._serialized, true);
                await chat.sendMessage("🎨 Generating your image...");
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
        if (isGroupChat) {
            if (trimmedMessage.toLowerCase().startsWith(BOT_PREFIX)) {
                processedMessage = trimmedMessage.slice(BOT_PREFIX.length).trim();
                shouldProcess = processedMessage.length > 0;
            }
        } else {
            shouldProcess = true;
        }
        if (shouldProcess) {
            await processMessageWithQueue(chat, message, processedMessage);
        }
    } catch (error) {
        console.error(chalk.red('Message handling error:'), error);
        handleConnectionState('ERROR');
    }
});

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

console.log('Starting WhatsApp client...\n');
client.initialize()
    .then(() => handleConnectionState('INITIALIZING'))
    .catch(async (error) => {
        console.error(chalk.red('Initialization failed:'), error);
        // Remove ZIP error handling since we're preventing ZIP operations
        handleConnectionState('INITIALIZATION_FAILED');
        await reconnect();
    });

const shutdown = async () => {
    console.log(chalk.yellow('\nShutting down...'));
    try {
        handleConnectionState('SHUTTING_DOWN');
        await client.destroy();
        console.log(chalk.green('Successfully logged out and cleaned up.'));
    } catch (error) {
        console.error(chalk.red('Error during shutdown:'), error);
        handleConnectionState('SHUTDOWN_ERROR');
    }
    process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);