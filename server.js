const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
app.use(express.json());

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', '*');
  next();
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const pool = new Pool({
  connectionString: 'postgresql://postgres.rizjzshhbxcvagllxxbx:ShahzadKhan.472@aws-0-ap-northeast-2.pooler.supabase.com:5432/postgres',
  ssl: { rejectUnauthorized: false }
});

const JWT_SECRET = 'my_aviator_super_secret_key_123';

let activeBets = {}; 
let queuedBets = {}; 
let history = [1.20, 5.81, 2.10, 1.05, 12.40, 1.85, 3.20];

// AUTH ROUTES
app.post('/api/register', async (req, res) => {
  const { phone, password } = req.body;
  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = await pool.query('INSERT INTO users (phone, password_hash) VALUES ($1, $2) RETURNING id', [phone, hashedPassword]);
    await pool.query('INSERT INTO wallets (user_id, balance) VALUES ($1, $2)', [newUser.rows[0].id, 1000.00]);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ success: false, error: 'Phone already exists' });
  }
});

app.post('/api/login', async (req, res) => {
  const { phone, password } = req.body;
  try {
    const userQuery = await pool.query('SELECT * FROM users WHERE phone = $1', [phone]);
    if (userQuery.rows.length === 0) return res.status(400).json({ success: false, error: 'User not found' });

    const user = userQuery.rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(400).json({ success: false, error: 'Wrong password' });

    const token = jwt.sign({ userId: user.id }, JWT_SECRET);
    res.json({ success: true, token });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/wallet', async (req, res) => {
  try {
    const token = req.headers.authorization.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);
    const wallet = await pool.query('SELECT balance FROM wallets WHERE user_id = $1', [decoded.userId]);
    res.json({ balance: wallet.rows[0].balance });
  } catch (err) {
    res.status(401).json({ error: 'Unauthorized' });
  }
});

// MANUAL DEPOSIT ROUTES
app.post('/api/deposit/request', async (req, res) => {
  try {
    const token = req.headers.authorization.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);
    const { amount, method, trxId } = req.body;

    await pool.query(
      'INSERT INTO deposits (user_id, amount, method, trx_id, status) VALUES ($1, $2, $3, $4, $5)',
      [decoded.userId, amount, method, trxId, 'PENDING']
    );

    res.json({ success: true, message: 'Deposit request submitted successfully' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ADMIN APPROVAL ROUTE
app.post('/api/admin/approve-deposit', async (req, res) => {
  try {
    const { depositId } = req.body;
    const depQuery = await pool.query('SELECT * FROM deposits WHERE id = $1 AND status = $2', [depositId, 'PENDING']);
    
    if (depQuery.rows.length === 0) {
      return res.status(400).json({ success: false, error: 'Deposit request not found or already processed' });
    }

    const deposit = depQuery.rows[0];
    await pool.query('UPDATE wallets SET balance = balance + $1 WHERE user_id = $2', [deposit.amount, deposit.user_id]);
    await pool.query('UPDATE deposits SET status = $1 WHERE id = $2', ['APPROVED', depositId]);

    res.json({ success: true, message: 'Deposit approved and balance added!' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// BETTING & GAME CONTROL
app.post('/api/bet', async (req, res) => {
  try {
    const token = req.headers.authorization.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);
    const { amount, panelId } = req.body;

    const wallet = await pool.query('SELECT balance FROM wallets WHERE user_id = $1', [decoded.userId]);
    const currentBalance = parseFloat(wallet.rows[0].balance);

    if (currentBalance < amount) {
      return res.status(400).json({ success: false, error: 'Insufficient balance' });
    }

    const newBalance = currentBalance - amount;
    await pool.query('UPDATE wallets SET balance = $1 WHERE user_id = $2', [newBalance, decoded.userId]);

    const key = `${decoded.userId}_${panelId}`;
    if (gameState === 'WAITING') {
      activeBets[key] = { amount, cashedOut: false, userId: decoded.userId };
      res.json({ success: true, newBalance, status: 'ACTIVE' });
    } else {
      queuedBets[key] = { amount, cashedOut: false, userId: decoded.userId };
      res.json({ success: true, newBalance, status: 'QUEUED' });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/cashout', async (req, res) => {
  try {
    const token = req.headers.authorization.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);
    const { panelId } = req.body;

    const key = `${decoded.userId}_${panelId}`;
    const userBet = activeBets[key];

    if (!userBet || userBet.cashedOut) {
      return res.status(400).json({ success: false, error: 'No active bet' });
    }

    if (gameState !== 'RUNNING') {
      return res.status(400).json({ success: false, error: 'Round not running' });
    }

    const winAmount = parseFloat((userBet.amount * multiplier).toFixed(2));
    userBet.cashedOut = true;

    const wallet = await pool.query('SELECT balance FROM wallets WHERE user_id = $1', [decoded.userId]);
    const updatedBalance = parseFloat(wallet.rows[0].balance) + winAmount;
    await pool.query('UPDATE wallets SET balance = $1 WHERE user_id = $2', [updatedBalance, decoded.userId]);

    res.json({ success: true, winAmount, newBalance: updatedBalance, cashedAt: multiplier });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

let multiplier = 1.00;
let gameState = 'WAITING';
let crashPoint = 0;

function broadcast(data) {
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(data));
    }
  });
}

function startBettingPhase() {
  gameState = 'WAITING';
  activeBets = { ...queuedBets };
  queuedBets = {};
  
  let countdown = 8;
  broadcast({ type: 'WAITING_PHASE', countdown, history });

  let timer = setInterval(() => {
    countdown--;
    if (countdown <= 0) {
      clearInterval(timer);
      startFlightPhase();
    } else {
      broadcast({ type: 'WAITING_PHASE', countdown, history });
    }
  }, 1000);
}

function startFlightPhase() {
  gameState = 'RUNNING';
  multiplier = 1.00;
  crashPoint = parseFloat((Math.random() * 5 + 1.05).toFixed(2));

  broadcast({ type: 'GAME_STARTED' });

  let interval = setInterval(() => {
    if (multiplier >= crashPoint) {
      clearInterval(interval);
      gameState = 'CRASHED';
      history.unshift(multiplier);
      if(history.length > 15) history.pop();
      
      broadcast({ type: 'CRASHED', finalMultiplier: multiplier, history });
      setTimeout(startBettingPhase, 3000);
    } else {
      multiplier = parseFloat((multiplier + 0.02).toFixed(2));
      broadcast({ type: 'MULTIPLIER_UPDATE', multiplier });
    }
  }, 100);
}

startBettingPhase();

server.listen(3000, () => {
  console.log('🚀 Game Server Running on http://localhost:3000');
});