const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs').promises;
const OpenAI = require('openai');
const sharp = require('sharp');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Security middleware
app.use(helmet());
app.use(cors({
  origin: process.env.FRONTEND_URL || 'https://youtuber.store',
  credentials: true
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // limit each IP to 10 requests per windowMs
  message: 'Too many thumbnail generation requests, please try again 
later.'
});
app.use('/api/generate', limiter);

// Body parsing middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    const uploadDir = 'uploads/temp';
    try {
      await fs.mkdir(uploadDir, { recursive: true });
      cb(null, uploadDir);
    } catch (error) {
      cb(error);
    }
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 
1E9);
    cb(null, 
`${file.fieldname}-${uniqueSuffix}${path.extname(file.originalname)}`);
  }
});

const upload = multer({
  storage: storage,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
    files: 3 // Max 3 reference images
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|webp/;
    const extname = 
allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);
    
    if (mimetype && extname) {
      return cb(null, true);
    } else {
      cb(new Error('Only image files (JPEG, PNG, WebP) are allowed!'));
    }
  }
});

// YouTube thumbnail style prompts for different niches
const stylePrompts = {
  mrbeast: "Ultra-dramatic, high-energy YouTube thumbnail in MrBeast 
style: vibrant colors, shocked facial expressions, bold yellow and red 
text overlays, dynamic composition with explosive elements, professional 
studio lighting",
  
  lifestyle: "Clean, aesthetic lifestyle YouTube thumbnail: soft pastel 
colors, minimalist composition, bright natural lighting, aspirational 
mood, clean typography",
  
  tech: "Modern tech YouTube thumbnail: sleek design, gradient 
backgrounds, glowing elements, futuristic aesthetics, bold contrasting 
colors, clean product shots",
  
  gaming: "Epic gaming YouTube thumbnail: dramatic action scenes, neon 
colors, dynamic angles, intense character expressions, glowing effects, 
bold game-style typography",
  
  business: "Professional business YouTube thumbnail: clean corporate 
aesthetic, confident poses, modern office backgrounds, sophisticated color 
palette, authoritative presence"
};

// Utility function to clean up uploaded files
async function cleanupFiles(filePaths) {
  for (const filePath of filePaths) {
    try {
      await fs.unlink(filePath);
    } catch (error) {
      console.error(`Error deleting file ${filePath}:`, error);
    }
  }
}

// Function to optimize image for YouTube thumbnail dimensions
async function optimizeForYouTube(imageBuffer) {
  return await sharp(imageBuffer)
    .resize(1280, 720, {
      fit: 'cover',
      position: 'center'
    })
    .jpeg({ quality: 90 })
    .toBuffer();
}

// Main thumbnail generation endpoint
app.post('/api/generate', upload.array('referenceImages', 3), async (req, 
res) => {
  const uploadedFiles = req.files ? req.files.map(file => file.path) : [];
  
  try {
    const { prompt, style = 'mrbeast', customStyle, includeText, 
thumbnailText } = req.body;
    
    if (!prompt) {
      return res.status(400).json({ error: 'Prompt is required' });
    }

    // Build the complete prompt
    let fullPrompt = stylePrompts[style] || stylePrompts.mrbeast;
    
    if (customStyle) {
      fullPrompt = customStyle;
    }
    
    fullPrompt += `. ${prompt}`;
    
    if (includeText && thumbnailText) {
      fullPrompt += `. Include bold, eye-catching text that says 
"${thumbnailText}"`;
    }
    
    fullPrompt += ". Format: YouTube thumbnail, 16:9 aspect ratio, 
1280x720 resolution, high quality, attention-grabbing";

    console.log('Generating thumbnail with prompt:', fullPrompt);

    // Generate image with DALL-E 3
    const response = await openai.images.generate({
      model: "dall-e-3",
      prompt: fullPrompt,
      n: 1,
      size: "1792x1024", // Closest to 16:9 ratio available
      quality: "hd",
      response_format: "url"
    });

    const imageUrl = response.data[0].url;
    
    // Download and optimize the generated image
    const imageResponse = await fetch(imageUrl);
    const imageBuffer = await imageResponse.arrayBuffer();
    const optimizedBuffer = await 
optimizeForYouTube(Buffer.from(imageBuffer));

    // Save optimized thumbnail
    const outputDir = 'uploads/generated';
    await fs.mkdir(outputDir, { recursive: true });
    
    const fileName = `thumbnail-${Date.now()}.jpg`;
    const filePath = path.join(outputDir, fileName);
    
    await fs.writeFile(filePath, optimizedBuffer);

    // Clean up uploaded reference files
    await cleanupFiles(uploadedFiles);

    res.json({
      success: true,
      thumbnailUrl: `/api/download/${fileName}`,
      originalPrompt: prompt,
      fullPrompt: fullPrompt,
      style: style,
      dimensions: { width: 1280, height: 720 }
    });

  } catch (error) {
    console.error('Thumbnail generation error:', error);
    
    // Clean up files on error
    await cleanupFiles(uploadedFiles);
    
    res.status(500).json({
      error: 'Failed to generate thumbnail',
      details: error.message
    });
  }
});

// Download generated thumbnail
app.get('/api/download/:filename', async (req, res) => {
  try {
    const filename = req.params.filename;
    const filePath = path.join('uploads/generated', filename);
    
    // Check if file exists
    await fs.access(filePath);
    
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Content-Disposition', `attachment; 
filename="${filename}"`);
    res.sendFile(path.resolve(filePath));
    
  } catch (error) {
    res.status(404).json({ error: 'Thumbnail not found' });
  }
});

// Get available styles
app.get('/api/styles', (req, res) => {
  const styles = Object.keys(stylePrompts).map(key => ({
    id: key,
    name: key.charAt(0).toUpperCase() + key.slice(1),
    description: stylePrompts[key].split(':')[1]?.trim() || 'Custom style'
  }));
  
  res.json({ styles });
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    version: '1.0.0'
  });
});

// Cleanup old files periodically (run every hour)
setInterval(async () => {
  try {
    const generatedDir = 'uploads/generated';
    const tempDir = 'uploads/temp';
    
    for (const dir of [generatedDir, tempDir]) {
      try {
        const files = await fs.readdir(dir);
        const now = Date.now();
        
        for (const file of files) {
          const filePath = path.join(dir, file);
          const stats = await fs.stat(filePath);
          const fileAge = now - stats.mtime.getTime();
          
          // Delete files older than 24 hours
          if (fileAge > 24 * 60 * 60 * 1000) {
            await fs.unlink(filePath);
            console.log(`Cleaned up old file: ${filePath}`);
          }
        }
      } catch (error) {
        console.error(`Error cleaning directory ${dir}:`, error);
      }
    }
  } catch (error) {
    console.error('Cleanup error:', error);
  }
}, 60 * 60 * 1000); // Run every hour

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('Unhandled error:', error);
  
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'File too large. Maximum size 
is 10MB.' });
    }
    if (error.code === 'LIMIT_FILE_COUNT') {
      return res.status(400).json({ error: 'Too many files. Maximum is 3 
reference images.' });
    }
  }
  
  res.status(500).json({ error: 'Internal server error' });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

app.listen(PORT, () => {
  console.log(`🚀 YouTube Thumbnail Generator API running on port 
${PORT}`);
  console.log(`📱 Health check: http://localhost:${PORT}/api/health`);
});

