require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');

// 5️⃣ SECURE SMS PARSER ENDPOINT (CRITICAL)
if (!process.env.SMS_SECRET || !process.env.MONGO_URI) {
  console.error("❌ CRITICAL: Missing required environment variables (SMS_SECRET, MONGO_URI).");
  process.exit(1);
}

const app = express();
const PORT = process.env.PORT || 3002;

app.use(cors());
app.use(express.json());

// MongoDB Connection
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('✅ SMS Parser Service: Connected to MongoDB'))
  .catch(err => {
    console.error('❌ SMS Parser Connection Error:', err);
    process.exit(1);
  });

const messageSchema = new mongoose.Schema({
  from: String,
  body: String,
  receivedAt: { type: Date, default: Date.now },
  deviceId: String
}, { collection: 'pending_messages' });

const Message = mongoose.model('Message', messageSchema);

// Endpoint for external Android app/Tasker to push SMS
// 5️⃣ SECURE SMS PARSER ENDPOINT (CRITICAL)
app.post('/api/push-sms', async (req, res) => {
  if (req.headers['x-sms-secret'] !== process.env.SMS_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const { from, body, deviceId } = req.body;
    if (!body) return res.status(400).json({ error: "No body" });
    const msg = new Message({ from, body, deviceId });
    await msg.save();
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Endpoint for Frontend to fetch and clear pending messages
app.get('/api/sync-sms', async (req, res) => {
  try {
    const messages = await Message.find({}).sort({ receivedAt: -1 }).limit(50);
    if (messages.length > 0) {
        const ids = messages.map(m => m._id);
        await Message.deleteMany({ _id: { $in: ids } });
    }
    res.json({ success: true, count: messages.length, messages });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => console.log(`📡 SMS Parser Service running on port ${PORT}`));