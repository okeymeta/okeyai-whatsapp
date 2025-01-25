import express from 'express';
import { Client } from 'whatsapp-web.js';
import mongoose from 'mongoose';
import { MongoStore } from 'wwebjs-mongo';

const app = express();
const port = process.env.PORT || 3000;

// MongoDB connection
const MONGODB_URI = process.env.MONGODB_URI;
let store;

mongoose.connect(MONGODB_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
}).then(() => {
    console.log('Connected to MongoDB Atlas');
    store = new MongoStore({ mongoose: mongoose });
});

// Session schema for storing WhatsApp sessions
const sessionSchema = new mongoose.Schema({
    id: String,
    data: Object,
    status: String,
    updatedAt: { type: Date, default: Date.now }
});

const Session = mongoose.model('Session', sessionSchema);

let whatsappClient = null;
let isAuthenticated = false;

// Initialize WhatsApp client
async function initializeWhatsApp() {
    if (whatsappClient) return;

    whatsappClient = new Client({
        authStrategy: new LocalAuth({
            clientId: 'whatsapp-bot',
            dataPath: './.wwebjs_auth',
            store: store
        }),
        puppeteer: {
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--single-process',
                '--no-zygote'
            ],
            headless: true
        },
        webVersionCache: { 
            type: 'remote',
            store: store
        }
    });

    whatsappClient.on('authenticated', async (session) => {
        isAuthenticated = true;
        await Session.findOneAndUpdate(
            { id: 'whatsapp-session' },
            { 
                data: session,
                status: 'authenticated',
                updatedAt: new Date()
            },
            { upsert: true }
        );
    });

    // Restore session if exists
    const savedSession = await Session.findOne({ id: 'whatsapp-session' });
    if (savedSession?.data) {
        await whatsappClient.initialize(savedSession.data);
    } else {
        await whatsappClient.initialize();
    }
}

// API endpoints
app.post('/api/message', async (req, res) => {
    try {
        if (!whatsappClient || !isAuthenticated) {
            await initializeWhatsApp();
        }
        const { to, message } = req.body;
        await whatsappClient.sendMessage(to, message);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
    res.json({
        status: isAuthenticated ? 'authenticated' : 'not_authenticated',
        uptime: process.uptime(),
        mongoConnection: mongoose.connection.readyState === 1
    });
});

export default app;
