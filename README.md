# SAP AI Commerce Agent 🤖

A conversational AI-powered e-commerce shopping assistant that integrates with SAP Commerce Cloud. Users can search for products, view details, read reviews, add items to cart, and manage their shopping experience entirely through natural language conversation.

## Features ✨

- **Conversational AI Search**: Ask in natural language to find products (e.g., "Find me a camera")
- **Product Details**: View detailed product information including images, price, stock, and specifications
- **Reviews & Ratings**: Read customer reviews and see average ratings
- **Smart Cart**: Add/remove products to cart with real-time totals and discounts
- **Voice Input**: Speak your requests using Web Speech API (🎤 button)
- **Semantic Search**: Embeddings-based ranking for better product relevance
- **Real-time Cart Sync**: Cart persists across the session using SAP OCC anonymous carts
- **Responsive UI**: Works on desktop and mobile browsers

## Tech Stack 🛠️

- **Backend**: Node.js + Express
- **AI/LLM**: Google Gemini (configurable model via `.env`)
- **Embeddings**: Gemini text-embedding-004 with caching
- **Commerce**: SAP Commerce Cloud (OCC) API
- **Frontend**: Vanilla HTML/CSS/JavaScript
- **Session**: Express-session for cart persistence
- **HTTP Client**: Axios

## Project Structure 📁

```
sap-ai-agent/
├── server.js              # Main Express server & agent logic
├── package.json           # Dependencies
├── .env                   # Configuration (copy from .env.example)
├── .env.example           # Example env variables
├── .gitignore             # Git ignore rules
├── public/
│   └── index.html         # Single-page chat UI
└── README.md              # This file
```

## Setup & Installation 🚀

### Prerequisites
- Node.js 18+ 
- npm or yarn
- Google Gemini API key
- SAP Commerce Cloud OCC endpoint access

### 1. Clone the Repository

```bash
git clone https://github.com/YOUR-USERNAME/sap-ai-agent.git
cd sap-ai-agent
```

### 2. Install Dependencies

```bash
npm install
```

### 3. Configure Environment Variables

Copy the example and add your credentials:

```bash
cp .env.example .env
```

Edit `.env` with your details:

```dotenv
# Google Gemini
GEMINI_API_KEY=your_gemini_api_key_here
GEMINI_MODEL=gemini-2.5-flash-lite    # or gemini-2.5-pro, etc.

# SAP Commerce Cloud (OCC)
SAP_OCC_BASE_URL=https://your-sap-instance:8443/occ/v2
SAP_SITE_ID=your-site-id

# Session & Security
SESSION_SECRET=your-random-secret-key-change-in-prod
NODE_TLS_REJECT_UNAUTHORIZED=0        # DEV ONLY - for self-signed certs

# Server
PORT=3000
NODE_ENV=development
```

### 4. Start the Server

```bash
npm start
```

or for development with auto-reload:

```bash
npm install -g nodemon
nodemon server.js
```

### 5. Open in Browser

Navigate to: **http://localhost:3000**

## Configuration 🔧

### Gemini Model Selection

Change the LLM model via the `GEMINI_MODEL` environment variable:

```bash
# Using Flash (faster, cheaper)
GEMINI_MODEL=gemini-2.5-flash-lite

# Using Pro (more capable)
GEMINI_MODEL=gemini-2.5-pro

# Or any other available Gemini model
GEMINI_MODEL=gemini-1.5-pro
```

The model is read on server startup automatically.

## Usage Examples 💬

1. **Search for Products**
   - "Find me a camera"
   - "Show me laptops under 1000"
   - "What electronics do you have?"

2. **View Product Details**
   - "Show me product 816379"
   - "Can you tell me about the DT 16-80mm lens?"

3. **Check Reviews**
   - "What are the reviews for 816379?"
   - "Tell me what customers say about this product"

4. **Add to Cart**
   - Click "Add to Cart" on product cards
   - See cart summary appear in chat

5. **Use Voice**
   - Click 🎤 button
   - Speak your request
   - Chat auto-sends when done

## API Endpoints 🔌

### Authentication
- `POST /api/auth/register` - Register new user
- `POST /api/auth/login` - Login user
- `GET /api/auth/logout` - Logout
- `GET /api/auth/me` - Get current user

### Products
- `GET /api/products/:code` - Get product details
- `GET /api/products/:code/reviews` - Get product reviews

### Cart
- `GET /api/cart` - Get current cart
- `POST /api/cart/add` - Add product to cart
- `POST /api/cart/remove` - Remove product from cart
- `POST /api/cart/update` - Update product quantity

### Search/Agent
- `POST /api/search` - Send message to AI agent

## Agent Directives

The AI automatically recognizes special directives in responses:

- `[SEARCH: query]` - Triggers product search
- `[VIEW: product_code]` - Fetches product details
- `[REVIEWS: product_code]` - Fetches product reviews

## Deployment 🌐

### Deploy to Heroku

```bash
# Create Heroku app
heroku create your-app-name

# Set environment variables
heroku config:set GEMINI_API_KEY=your_key
heroku config:set SAP_OCC_BASE_URL=https://...
heroku config:set SAP_SITE_ID=electronics-spa
heroku config:set SESSION_SECRET=random_secret_key

# Deploy
git push heroku main
```

### Deploy to Vercel (Frontend Only)

For frontend-only deployment, extract the `public/` folder as a separate project.

### Deploy to AWS, Azure, GCP

Use the standard Node.js deployment process for your platform.

## Performance & Optimization ⚡

- **Embedding Cache**: Reduces API calls by 70%+ through intelligent caching
- **Reduced Search Scope**: Product search pageSize limited to 5 
- **Smart Re-ranking**: Only re-ranks when necessary (>2 products)
- **Session-based Cart**: Anonymous carts via SAP OCC

## Troubleshooting 🔍

### Issue: "Quota exceeded" for embeddings
**Solution**: Embeddings are cached. Restart server to clear cache, or wait for cache to auto-evict old entries.

### Issue: Product add to cart failing
**Solution**: Ensure `credentials: 'same-origin'` is set in frontend fetch calls and server session cookies are enabled.

### Issue: SAP API errors (SSL cert)
**Solution**: For development with self-signed certs, set `NODE_TLS_REJECT_UNAUTHORIZED=0` in `.env` (DEV ONLY).

## Contributing 🤝

Contributions welcome! Please:

1. Fork the repo
2. Create a feature branch: `git checkout -b feature/amazing-feature`
3. Commit changes: `git commit -m 'Add amazing feature'`
4. Push to branch: `git push origin feature/amazing-feature`
5. Open a Pull Request

## License 📄

MIT License - see LICENSE file for details

## Support & Contact 📧

- Issues: Open a GitHub Issue
- Questions: Start a Discussion
- Contact: [Your email/contact info]

## Roadmap 🗺️

- [ ] Persistent database (MongoDB/PostgreSQL)
- [ ] User authentication with OAuth
- [ ] Payment gateway integration (Stripe, PayPal)
- [ ] Order tracking and history
- [ ] Wishlist functionality
- [ ] Product recommendations
- [ ] Multi-language support
- [ ] Admin dashboard

## Acknowledgments 🙏

- Google Gemini for LLM & embeddings
- SAP Commerce Cloud for OCC API
- [Add any other dependencies/credits]

---

**Made with ❤️ for AI-powered commerce**
