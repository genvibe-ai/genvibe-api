# LMArena API

A standalone API server for LMArena cookie management with a modern React dashboard.

## Features

- 🍪 Cookie management with multi-region rotation
- 📊 Real-time statistics dashboard
- ✅ Multi-select bulk operations
- 🎨 Premium gradient UI with animations
- 📱 Responsive mobile design

## Quick Start

### 1. Install Dependencies

```bash
npm install
cd dashboard && npm install && cd ..
```

### 2. Build Dashboard

```bash
cd dashboard && npm run build && cd ..
```

### 3. Setup Environment

```bash
cp .env.example .env
# Edit .env with your configuration
```

### 4. Start Server

```bash
npm start
```

Visit `http://localhost:3000/dashboard`

## Deployment on Railway

### Option 1: Deploy from GitHub (Recommended)

1. **Create GitHub Repository**:
   ```bash
   git init
   git add .
   git commit -m "Initial commit"
   git branch -M main
   git remote add origin https://github.com/genvibe-ai/genvibe-api.git
   git push -u origin main
   ```

2. **Deploy to Railway**:
   - Go to [railway.app](https://railway.app)
   - Click "New Project" → "Deploy from GitHub repo"
   - Select your `genvibe-api` repository
   - Railway will auto-detect and deploy

3. **Add Environment Variables**:
   - In Railway dashboard, go to Variables
   - Add your `.env` variables

### Option 2: Deploy with Railway CLI

```bash
# Install Railway CLI
npm install -g @railway/cli

# Login
railway login

# Initialize project
railway init

# Deploy
railway up
```

## API Endpoints

- `GET /dashboard` - Dashboard UI
- `GET /dashboard/api/cookies` - Get all cookies
- `POST /dashboard/api/cookies` - Add cookie
- `POST /dashboard/api/cookies/bulk-delete` - Delete multiple cookies
- `PATCH /dashboard/api/cookies/:region/toggle` - Toggle cookie status
- `DELETE /dashboard/api/cookies/:region` - Delete cookie
- `GET /dashboard/api/stats/summary` - Get statistics

## Tech Stack

- **Backend**: Express.js, Node.js
- **Database**: SQLite (better-sqlite3)
- **Dashboard**: React, Vite, Framer Motion
- **Queue**: p-queue for concurrency control

## License

MIT
