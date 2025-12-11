
require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// MongoDB Connection
const MONGO_URI = process.env.MONGO_URI;

if (!MONGO_URI) {
  console.error("❌ MONGODB_URI is missing in .env file");
  // process.exit(1); // Removed to allow build without env locally if needed
} else {
    mongoose.connect(MONGO_URI)
    .then(() => console.log('✅ Connected to MongoDB'))
    .catch(err => console.error('❌ MongoDB Connection Error:', err));
}

// --- SCHEMAS ---

// 1. Message Schema (Global for sync)
const messageSchema = new mongoose.Schema({
  deviceId: String,
  from: String,
  body: String,
  receivedAt: Date,
  createdAt: Date
}, { collection: 'messages' });

const Message = mongoose.model('Message', messageSchema);

// 2. User Data Schemas
const transactionSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    id: String, // Client-side ID
    amount: Number,
    category: String,
    description: String,
    date: String,
    firewallDecision: String,
    firewallReason: String
});
const Transaction = mongoose.model('Transaction', transactionSchema);

const budgetSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    category: String,
    limit: Number,
    spent: { type: Number, default: 0 }
});
const Budget = mongoose.model('Budget', budgetSchema);

const goalSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    id: String,
    name: String,
    targetAmount: Number,
    savedAmount: Number,
    deadline: String,
    status: String
});
const Goal = mongoose.model('Goal', goalSchema);

const recurringSchema = new mongoose.Schema({
  id: String,
  name: String,
  amount: Number,
  date: Number
});

const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
  settings: {
    monthlyIncome: { type: Number, default: 0 },
    currentBalance: { type: Number, default: 0 },
    currency: { type: String, default: 'INR' },
    recurringExpenses: [recurringSchema],
    onboardingComplete: { type: Boolean, default: false }
  }
}, { collection: 'users' });

const User = mongoose.model('User', userSchema);

// --- MIDDLEWARE ---

const verifyToken = (req, res, next) => {
    const token = req.headers['authorization'];
    if (!token) return res.status(403).json({ error: "No token provided" });
  
    jwt.verify(token, process.env.JWT_SECRET || 'fallback_secret', (err, decoded) => {
      if (err) return res.status(500).json({ error: "Failed to authenticate token" });
      req.userId = decoded.id;
      next();
    });
};

// --- AUTH ROUTES ---

// Register
app.post('/api/auth/register', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: "Username and password required" });

    const existingUser = await User.findOne({ username });
    if (existingUser) return res.status(400).json({ error: "Username already taken" });

    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = new User({ username, password: hashedPassword });
    await newUser.save();

    res.json({ success: true, message: "User created successfully" });
  } catch (error) {
    res.status(500).json({ error: "Registration failed" });
  }
});

// Login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await User.findOne({ username });

    if (!user) return res.status(400).json({ error: "User not found" });

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).json({ error: "Invalid credentials" });

    const token = jwt.sign({ id: user._id, username: user.username }, process.env.JWT_SECRET || 'fallback_secret', { expiresIn: '1d' });

    res.json({ success: true, token, username: user.username });
  } catch (error) {
    res.status(500).json({ error: "Login failed" });
  }
});

// --- USER DATA ROUTES ---

// 1. Get All Data (App Hydration)
app.get('/api/data', verifyToken, async (req, res) => {
    try {
        const user = await User.findById(req.userId);
        const transactions = await Transaction.find({ userId: req.userId }).sort({ date: -1 });
        const budgets = await Budget.find({ userId: req.userId });
        const goals = await Goal.find({ userId: req.userId });

        res.json({
            success: true,
            settings: user.settings,
            transactions,
            budgets,
            goals
        });
    } catch (error) {
        res.status(500).json({ error: "Failed to fetch data" });
    }
});

// 2. Onboarding / Settings Update
app.post('/api/onboarding', verifyToken, async (req, res) => {
    try {
        const { monthlyIncome, currentBalance, recurringExpenses, initialBudgets } = req.body;
        const user = await User.findById(req.userId);

        // Update settings
        user.settings.monthlyIncome = monthlyIncome;
        user.settings.currentBalance = currentBalance;
        user.settings.recurringExpenses = recurringExpenses;
        user.settings.onboardingComplete = true;
        await user.save();

        // Create Initial Budgets
        if (initialBudgets && initialBudgets.length > 0) {
            await Budget.deleteMany({ userId: req.userId }); // Clear old if any
            const budgetDocs = initialBudgets.map(b => ({ ...b, userId: req.userId }));
            await Budget.insertMany(budgetDocs);
        }

        res.json({ success: true, settings: user.settings });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Onboarding failed" });
    }
});

// 3. Transactions
app.post('/api/transactions', verifyToken, async (req, res) => {
    try {
        const { transaction } = req.body;
        const newTx = new Transaction({ ...transaction, userId: req.userId });
        await newTx.save();
        
        // Update Budget Spending
        const budget = await Budget.findOne({ userId: req.userId, category: transaction.category });
        if (budget) {
            budget.spent += transaction.amount;
            await budget.save();
        }

        res.json({ success: true, transaction: newTx });
    } catch (error) {
        res.status(500).json({ error: "Failed to save transaction" });
    }
});

// Sync multiple (from SMS)
app.post('/api/transactions/sync', verifyToken, async (req, res) => {
    try {
        const { transactions } = req.body;
        const docs = transactions.map(t => ({ ...t, userId: req.userId }));
        
        // Basic dedup based on ID check (optional, but good)
        // For simplicity, just insert
        await Transaction.insertMany(docs);

        // Update budgets for all new transactions
        for (const tx of transactions) {
             const budget = await Budget.findOne({ userId: req.userId, category: tx.category });
             if (budget) {
                 budget.spent += tx.amount;
                 await budget.save();
             }
        }

        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: "Sync failed" });
    }
});

// 4. Budgets Update (ShiftBudget)
app.post('/api/budgets', verifyToken, async (req, res) => {
    try {
        const { budgets } = req.body;
        // Upsert or replace
        for (const b of budgets) {
            await Budget.findOneAndUpdate(
                { userId: req.userId, category: b.category },
                { limit: b.limit, spent: b.spent },
                { upsert: true, new: true }
            );
        }
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: "Failed to update budgets" });
    }
});

// 5. Goals
app.post('/api/goals', verifyToken, async (req, res) => {
    try {
        const { goal } = req.body;
        const newGoal = new Goal({ ...goal, userId: req.userId });
        await newGoal.save();
        res.json({ success: true, goal: newGoal });
    } catch (error) {
        res.status(500).json({ error: "Failed to save goal" });
    }
});

// SMS Cloud Sync (Existing)
app.get('/api/sync-sms', async (req, res) => {
  try {
    const messages = await Message.find({}).sort({ receivedAt: -1 }).limit(50);
    if (messages.length === 0) return res.json({ success: true, count: 0, messages: [] });

    // Clean up
    const idsToDelete = messages.map(m => m._id);
    await Message.deleteMany({ _id: { $in: idsToDelete } });

    res.json({ success: true, count: messages.length, messages });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 MoneyOS Server running on port ${PORT}`);
});
