import { MongoClient } from 'mongodb';
import makeWASocket, { DisconnectReason } from '@adiwajshing/baileys';
import { Boom } from '@hapi/boom';
import axios from 'axios';

// MongoDB Atlas connection (hardcoded for demo, replace USERNAME/PASSWORD as needed)
const MONGO_URI = "mongodb+srv://okeymeta:okeymeta514@cluster0.u0wdr.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0";
const mongoClient = new MongoClient(MONGO_URI);
// Cache the connection to reuse in subsequent invocations
if (!global._mongoClientPromise) {
    global._mongoClientPromise = mongoClient.connect();
}
const clientPromise = global._mongoClientPromise;

// Serverless handler for Vercel
export default async function handler(req, res) {
    try {
        // Wait for the MongoDB connection and retrieve collection
        const connectedClient = await clientPromise;
        const db = connectedClient.db('whatbot');
        const sessions = db.collection('sessions');

        // Helper functions for session persistence (defined within handler to use current sessions)
        async function loadSession() {
            const doc = await sessions.findOne({ _id: 'baileys' });
            return doc ? doc.authState : {};
        }
        
        async function saveSession(authState) {
            await sessions.updateOne({ _id: 'baileys' }, { $set: { authState } }, { upsert: true });
        }

        const existingAuth = await loadSession();

        const sock = makeWASocket({
            auth: existingAuth,
            printQRInTerminal: false, // must be false per BAILEYS pairing documentation
            browser: { name: 'Desktop', version: '1.0.0' },
            syncFullHistory: true,
            // ...other optional BAILEYS options (e.g. cachedGroupMetadata)...
        });

        // Update session credentials when they change
        sock.ev.on('creds.update', async () => {
            await saveSession(sock.authState);
        });

        // Listen for connection updates
        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;
            if (connection === 'close') {
                const shouldReconnect = (lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut);
                if (shouldReconnect) {
                    // In a persistent environment, reconnection logic would be added here
                    console.log('Reconnecting...');
                }
            } else if (connection === 'open') {
                console.log('Connection opened');
            }
        });

        // Updated message handler: Process AI responses similar to the original server code
        sock.ev.on('messages.upsert', async ({ messages }) => {
            for (const m of messages) {
                if (m.message) {
                    const jid = m.key.remoteJid;
                    // Prefer conversation text or fallback to extended text
                    let msgText = m.message.conversation || m.message?.extendedTextMessage?.text;
                    if (!msgText) continue;
                    
                    // In group chats require BOT_PREFIX ("okeyai")
                    const isGroup = jid.endsWith('@g.us');
                    if (isGroup && !msgText.toLowerCase().startsWith('okeyai')) continue;
                    const processedText = isGroup ? msgText.slice('okeyai'.length).trim() : msgText;
                    
                    try {
                        const response = await axios.get(
                            'https://api-okeymeta.vercel.app/api/ssailm/model/okeyai3.0-vanguard/okeyai',
                            {
                                params: {
                                    input: processedText,
                                    imgUrl: '',
                                    APiKey: `okeymeta-${jid}`
                                },
                                timeout: 90000
                            }
                        );
                        const reply = response.data?.response?.trim() || "I'm having issues processing your message.";
                        await sock.sendMessage(jid, { text: reply }, { quoted: m });
                    } catch (err) {
                        await sock.sendMessage(
                            jid,
                            { text: "I'm having trouble processing your message right now. Please try again." },
                            { quoted: m }
                        );
                    }
                }
            }
        });

        // Pairing code logic: if not registered, request pairing code using a phone number (only digits, including country code)
        if (!sock.authState.creds?.registered) {
            // Replace with a valid phone number (e.g. "11234567890")
            const pairingCode = await sock.requestPairingCode("2349138028543");
            console.log('Pairing Code:', pairingCode);
            res.status(200).json({ message: 'Pairing Code generated', pairingCode });
        } else {
            res.status(200).json({ message: 'WhatsApp connected via Baileys' });
        }
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: error.message });
    }
}