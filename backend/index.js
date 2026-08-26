require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const multer = require('multer');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { tryOnClothing } = require('./services/aiService');
const path = require('path');
const app = express();
const port = process.env.PORT || 5000;

// PostgreSQL connection pool
const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
});

pool.connect((err, client, release) => {
  if (err) {
    return console.error('Error acquiring client', err.stack);
  }
  client.query('SELECT NOW()', (err, result) => {
    release();
    if (err) {
      return console.error('Error executing query', err.stack);
    }
    console.log('Database connected:', result.rows[0].now);
  });
});

app.use(cors());
app.use(express.json()); // For parsing application/json

// Serve static files from the 'public' directory
app.use(express.static(path.join(__dirname, 'public')));
// If you want to serve 'uploads' directly, you might add:
// app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// User registration route
app.post('/register', async (req, res) => {
  const { email, password } = req.body;

  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    const result = await pool.query(
      'INSERT INTO users (email, password) VALUES ($1, $2) RETURNING id, email',
      [email, hashedPassword]
    );
    res.status(201).json({ message: 'User registered successfully', user: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') { // Duplicate email error code
      return res.status(409).json({ error: 'Email already registered' });
    }
    console.error('Registration error', err.stack);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// User login route
app.post('/login', async (req, res) => {
  const { email, password } = req.body;

  try {
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    const user = result.rows[0];

    if (!user) {
      return res.status(400).json({ error: 'Invalid credentials' });
    }

    const isPasswordValid = await bcrypt.compare(password, user.password);

    if (!isPasswordValid) {
      return res.status(400).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign({ userId: user.id, email: user.email }, process.env.JWT_SECRET, { expiresIn: '1h' });
    res.status(200).json({ message: 'Logged in successfully', token });
  } catch (err) {
    console.error('Login error', err.stack);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// JWT authentication middleware
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

  if (token == null) return res.sendStatus(401); // No token

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) return res.sendStatus(403); // Invalid token
    req.user = user;
    next();
  });
};

// Protected route example
// Get user profile
app.get('/profile', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, email, height_cm, weight_kg, face_data_url FROM users WHERE id = $1',
      [req.user.userId]
    );
    const userProfile = result.rows[0];

    if (!userProfile) {
      return res.status(404).json({ error: 'User profile not found' });
    }

    res.status(200).json(userProfile);
  } catch (err) {
    console.error('Error fetching user profile', err.stack);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update user profile
app.put('/profile', authenticateToken, async (req, res) => {
  const { height_cm, weight_kg, face_data_url } = req.body;
  const userId = req.user.userId;

  try {
    const result = await pool.query(
      'UPDATE users SET height_cm = $1, weight_kg = $2, face_data_url = $3 WHERE id = $4 RETURNING id, email, height_cm, weight_kg, face_data_url',
      [height_cm, weight_kg, face_data_url, userId]
    );

    const updatedProfile = result.rows[0];

    if (!updatedProfile) {
      return res.status(404).json({ error: 'User profile not found' });
    }

    res.status(200).json({ message: 'Profile updated successfully', user: updatedProfile });
  } catch (err) {
    console.error('Error updating user profile', err.stack);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/protected', authenticateToken, (req, res) => {
  res.json({ message: 'This is a protected route!', user: req.user });
});

// GET /clothing endpoint
app.get('/clothing', authenticateToken, async (req, res) => {
  const userId = req.user.userId;
  try {
    const result = await pool.query(
      'SELECT id, image_url, category, color, created_at FROM clothing_items WHERE user_id = $1 ORDER BY created_at DESC',
      [userId]
    );
    res.status(200).json(result.rows);
  } catch (err) {
    console.error('Error fetching clothing items:', err.stack);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Multer configuration for memory storage
const upload = multer({ storage: multer.memoryStorage() });

// AWS S3 Client configuration
const s3 = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

// Route for clothing image upload
app.post('/upload/clothing', authenticateToken, upload.single('clothingImage'), async (req, res) => {
  const userId = req.user.userId;
  const { category, color } = req.body;

  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  const file = req.file;
  const fileName = `clothing/${userId}-${Date.now()}-${file.originalname}`;

  const uploadParams = {
    Bucket: process.env.S3_BUCKET_NAME,
    Key: fileName,
    Body: file.buffer,
    ContentType: file.mimetype,
  };

  try {
    await s3.send(new PutObjectCommand(uploadParams));
    const imageUrl = `https://${process.env.S3_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${fileName}`;

    const result = await pool.query(
      'INSERT INTO clothing_items (user_id, image_url, category, color) VALUES ($1, $2, $3, $4) RETURNING *',
      [userId, imageUrl, category, color]
    );

    res.status(201).json({ message: 'Clothing image uploaded and saved', clothingItem: result.rows[0] });
  } catch (err) {
    console.error('Error uploading clothing image or saving metadata', err.stack);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Route for AI try-on
app.post('/try-on', authenticateToken, async (req, res) => {
  const { clothingItemId } = req.body;
  const userId = req.user.userId;

  try {
    // 1. Fetch user's profile data (including face_data_url, height, weight)
    const userResult = await pool.query(
      'SELECT height_cm, weight_kg, face_data_url FROM users WHERE id = $1',
      [userId]
    );
    const userProfile = userResult.rows[0];

    if (!userProfile) {
      return res.status(404).json({ error: 'User profile not found' });
    }
    if (!userProfile.face_data_url) {
      return res.status(400).json({ error: 'Face data not available for user. Please upload your face data.' });
    }
    if (!userProfile.height_cm || !userProfile.weight_kg) {
      return res.status(400).json({ error: 'Height and/or weight not available for user. Please update your profile.' });
    }

    // 2. Fetch selected clothing item's image URL
    const clothingResult = await pool.query(
      'SELECT image_url FROM clothing_items WHERE id = $1 AND user_id = $2',
      [clothingItemId, userId]
    );
    const clothingItem = clothingResult.rows[0];

    if (!clothingItem) {
      return res.status(404).json({ error: 'Clothing item not found or does not belong to user' });
    }

    // 3. Call the AI try-on service
    const renderedImageUrl = await tryOnClothing(
      userProfile.face_data_url,
      userProfile.height_cm,
      userProfile.weight_kg,
      clothingItem.image_url
    );

    res.status(200).json({ message: 'AI try-on successful', renderedImageUrl });
  } catch (err) {
    console.error('Error during AI try-on process', err.stack);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Groq proxy — keeps API key server-side, never exposed to browser.
// Model is overridable via GROQ_MODEL env; default migrated off the deprecated
// llama-3.3-70b-versatile (decommissioned 2026-08-16) to Groq's recommended
// replacement openai/gpt-oss-120b.
const GROQ_MODEL = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';
app.post('/groq-chat', async (req, res) => {
  const { messages, max_tokens = 1024, temperature = 0.75 } = req.body;
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages array required' });
  }
  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
      },
      body: JSON.stringify({ model: GROQ_MODEL, messages, max_tokens, temperature }),
    });
    const data = await response.json();
    if (!response.ok) {
      // Mirrors frontend/api/groq-chat.js: never forward the provider's error
      // body to the browser (it leaks the org id, model, limits and a billing
      // link to our account). Log server-side; return status + generic code.
      console.error('[groq-chat] upstream error', response.status, JSON.stringify(data).slice(0, 500));
      return res.status(response.status).json({
        error: response.status === 429 ? 'rate_limited' : 'upstream_error',
      });
    }
    res.json(data);
  } catch (err) {
    console.error('Groq proxy error:', err);
    res.status(502).json({ error: 'upstream_unreachable' });
  }
});

app.get('/', (req, res) => {
  res.send('Hello from AI Try-On Backend!');
});

app.listen(port, () => {
  console.log(`AI Try-On backend listening at http://localhost:${port}`);
});

