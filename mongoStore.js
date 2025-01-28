import mongoose from 'mongoose';
import { Store } from 'whatsapp-web.js';

const sessionSchema = new mongoose.Schema({
    sessionId: String,
    session: String,
});

const Session = mongoose.model('Session', sessionSchema);

export class MongoStore extends Store {
    constructor() {
        super();
    }

    async sessionExists(sessionId) {
        const session = await Session.findOne({ sessionId });
        return session !== null;
    }

    async save(sessionId, session) {
        await Session.findOneAndUpdate(
            { sessionId },
            { session: JSON.stringify(session) },
            { upsert: true }
        );
        return true;
    }

    async extract(sessionId) {
        const session = await Session.findOne({ sessionId });
        return session ? JSON.parse(session.session) : null;
    }

    async delete(sessionId) {
        await Session.deleteOne({ sessionId });
        return true;
    }
}
