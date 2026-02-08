import 'dotenv/config';
import express from 'express';
import { GoogleGenAI } from "@google/genai";
import axios from "axios";
import path from 'path';
import { fileURLToPath } from 'url';
import session from 'express-session';
import crypto from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite';

// In-memory stores (replace with database in production)
const users = new Map();
const carts = new Map();
const orders = new Map();
let orderCounter = 1000;

// Session configuration
app.use(session({
    secret: process.env.SESSION_SECRET || 'your-secret-key-change-in-prod',
    resave: false,
    saveUninitialized: true,
    cookie: { 
        secure: process.env.NODE_ENV === 'production',
        httpOnly: true,
        maxAge: 24 * 60 * 60 * 1000 // 24 hours
    }
}));

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Authentication middleware
const requireAuth = (req, res, next) => {
    if (!req.session.userId) {
        return res.status(401).json({ error: 'Authentication required' });
    }
    next();
};

/**
 * Embedding Cache to reduce API calls
 * Stores embeddings for texts to avoid redundant API calls
 */
const embeddingCache = new Map();
const MAX_CACHE_SIZE = 100; // Limit cache to prevent memory bloat

function hashText(text) {
    // Simple hash for cache keys
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
        const char = text.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash; // Convert to 32bit integer
    }
    return Math.abs(hash).toString();
}

function getCachedEmbedding(text) {
    const key = hashText(text);
    return embeddingCache.get(key);
}

function setCachedEmbedding(text, embedding) {
    // Simple eviction: clear cache if it exceeds max size
    if (embeddingCache.size >= MAX_CACHE_SIZE) {
        const firstKey = embeddingCache.keys().next().value;
        embeddingCache.delete(firstKey);
    }
    const key = hashText(text);
    embeddingCache.set(key, embedding);
}

/**
 * Utility: Strip HTML tags and decode entities
 */
function stripHtml(html) {
    if (!html) return '';
    return html
        .replace(/<[^>]*>/g, '')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&#(\d+);/g, (match, dec) => String.fromCharCode(dec))
        .trim();
}

/**
 * Gemini Embedding for semantic search (with caching)
 */
async function getEmbedding(text) {
    // Check cache first
    const cached = getCachedEmbedding(text);
    if (cached) {
        console.log(`[Cache] Hit for: "${text.substring(0, 30)}..."`);
        return cached;
    }

    try {
        console.log(`[Embedding] Generating for: "${text.substring(0, 30)}..."`);
        const response = await client.models.embedContent({
            model: "text-embedding-004",
            content: { parts: [{ text: text }] }
        });
        const embedding = response.embedding?.values || [];
        
        // Cache the result
        if (embedding.length > 0) {
            setCachedEmbedding(text, embedding);
        }
        
        return embedding;
    } catch (error) {
        console.error("Embedding error:", error.message);
        return [];
    }
}

/**
 * Calculate cosine similarity between two embeddings
 */
function cosineSimilarity(a, b) {
    if (!a.length || !b.length) return 0;
    
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    
    for (let i = 0; i < a.length; i++) {
        dotProduct += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    
    normA = Math.sqrt(normA);
    normB = Math.sqrt(normB);
    
    return normA && normB ? dotProduct / (normA * normB) : 0;
}

/**
 * 1. SAP OCC API Connector with Semantic Search using Embeddings
 */
async function searchSAPProducts(query) {
    console.log(`[SAP API] Searching for: ${query}...`);
    try {
        const url = `${process.env.SAP_OCC_BASE_URL}/${process.env.SAP_SITE_ID}/products/search`;
        const response = await axios.get(url, {
            params: {
                query: query,
                fields: 'products(name,price(formattedValue),code,stock(stockLevelStatus),images(FULL),description)',
                pageSize: 5 // Reduced from 10 to minimize API calls
            }
        });

        if (!response.data.products || response.data.products.length === 0) {
            return "No products found.";
        }
        
        // Strip HTML from product data
        const cleanedProducts = response.data.products.map(p => ({
            ...p,
            name: stripHtml(p.name),
            description: p.description ? stripHtml(p.description) : ''
        }));

        // Skip semantic re-ranking for single result or if only 2 products
        if (cleanedProducts.length <= 2) {
            console.log(`[Embeddings] Skipping re-ranking for ${cleanedProducts.length} product(s)`);
            return JSON.stringify(cleanedProducts);
        }

        // Use Gemini Embeddings for semantic search re-ranking
        console.log(`[Embeddings] Ranking ${cleanedProducts.length} products semantically...`);
        const queryEmbedding = await getEmbedding(query);
        
        if (queryEmbedding.length === 0) {
            console.log('[Embeddings] Embedding failed, returning top results by keyword match');
            return JSON.stringify(cleanedProducts.slice(0, 3));
        }

        // Calculate similarity scores for each product
        const productsWithScores = await Promise.all(
            cleanedProducts.map(async (product) => {
                const productText = `${product.name} ${product.description}`;
                const productEmbedding = await getEmbedding(productText);
                
                const similarity = cosineSimilarity(queryEmbedding, productEmbedding);
                return {
                    ...product,
                    similarityScore: similarity
                };
            })
        );

        // Sort by similarity score (descending) and return top 3
        const rankedProducts = productsWithScores
            .sort((a, b) => b.similarityScore - a.similarityScore)
            .slice(0, 3)
            .map(({ similarityScore, ...product }) => product); // Remove score from response

        console.log(`[Embeddings] Re-ranked, returning top 3`);
        
        return JSON.stringify(rankedProducts);
    } catch (error) {
        console.error("SAP API Error:", error.message);
        return "Error connecting to SAP Commerce Cloud.";
    }
}

/**
 * 2. Agent Logic
 */
async function runAgent(userInput) {
    const systemPrompt = `You are a helpful SAP Commerce assistant. When users ask about products, extract the search query and start your response with [SEARCH: <query>] to trigger a product search. For example:
- User: "I need a camera"
- You: "[SEARCH: camera] Let me find some cameras for you..."  

If the user asks something that doesn't require a search, just respond normally without the [SEARCH] tag.`;

    const fullPrompt = `${systemPrompt}\n\nUser: ${userInput}\n\nAssistant:`;

    try {
        // Step A: Ask Gemini what to do
        const response = await client.models.generateContent({
            model: GEMINI_MODEL,
            contents: [{ role: "user", parts: [{ text: fullPrompt }] }],
        });

        const assistantResponse = response.candidates[0]?.content?.parts[0]?.text || "No response";

        // Step B: Check if AI wants reviews, view a specific product, or search SAP
        // Look for [REVIEWS: <code>] first
        const reviewsMatch = assistantResponse.match(/\[REVIEWS: ([^\]]+)\]/);
        if (reviewsMatch) {
            const code = reviewsMatch[1].trim();
            try {
                const url = `${process.env.SAP_OCC_BASE_URL}/${process.env.SAP_SITE_ID}/products/${code}/reviews`;
                const revResp = await axios.get(url, {
                    params: { lang: 'en', curr: 'USD' }
                });

                const reviews = revResp.data?.reviews || [];
                const averageRating = reviews.length ? (reviews.reduce((s, r) => s + (r.rating || 0), 0) / reviews.length) : 0;

                return {
                    response: assistantResponse,
                    reviews: reviews,
                    reviewsSummary: {
                        count: reviews.length,
                        averageRating: Math.round(averageRating * 100) / 100
                    }
                };
            } catch (err) {
                console.error('Reviews fetch error:', err.response?.data || err.message);
                return {
                    response: assistantResponse + '\n\n(Unable to fetch reviews)',
                    reviews: [],
                    reviewsSummary: { count: 0, averageRating: 0 },
                    error: true
                };
            }
        }

        // Look for [VIEW: <code>]
        const viewMatch = assistantResponse.match(/\[VIEW: ([^\]]+)\]/);
        if (viewMatch) {
            const code = viewMatch[1].trim();
            try {
                const url = `${process.env.SAP_OCC_BASE_URL}/${process.env.SAP_SITE_ID}/products/${code}`;
                const prodResp = await axios.get(url, {
                    params: {
                        fields: 'code,configurable,configuratorType,purchasable,name,summary,price(formattedValue,DEFAULT),images(galleryIndex,FULL),baseProduct,DEFAULT,averageRating,classifications,manufacturer,numberOfReviews,categories(FULL),baseOptions,variantOptions,variantType,stock(DEFAULT),description,availableForPickup,url,priceRange,multidimensional,tags,potentialPromotions(description),sapUnit',
                        lang: 'en',
                        curr: 'USD'
                    }
                });

                return {
                    response: assistantResponse,
                    viewed: true,
                    product: prodResp.data
                };
            } catch (err) {
                console.error('Product view error:', err.response?.data || err.message);
                return {
                    response: assistantResponse + '\n\n(Unable to fetch product details)',
                    viewed: false,
                    product: null,
                    error: true
                };
            }
        }

        // Otherwise check for [SEARCH: <query>]
        const searchMatch = assistantResponse.match(/\[SEARCH: ([^\]]+)\]/);
        if (searchMatch) {
            const query = searchMatch[1];

            // Execute actual SAP call
            const sapResults = await searchSAPProducts(query);

            // Step C: Get refined response with SAP data
            const refinedPrompt = `${systemPrompt}\n\nUser: ${userInput}\n\nSAP Products Found:\n${sapResults}\n\nBased on these products, provide a helpful response to the user:`;

            const refinedResponse = await client.models.generateContent({
                model: GEMINI_MODEL,
                contents: [{ role: "user", parts: [{ text: refinedPrompt }] }],
            });

            return {
                response: refinedResponse.candidates[0]?.content?.parts[0]?.text || "No response",
                searched: true,
                products: JSON.parse(sapResults)
            };
        }

        // Default: normal assistant response
        return {
            response: assistantResponse,
            searched: false,
            products: []
        };
    } catch (error) {
        console.error("[Error]:", error.message);
        return {
            response: `Error: ${error.message}`,
            searched: false,
            products: [],
            error: true
        };
    }
}

/**
 * 3. API Endpoints
 */

// AUTH ENDPOINTS
app.post('/api/auth/register', (req, res) => {
    const { email, password, firstName, lastName } = req.body;
    
    if (!email || !password) {
        return res.status(400).json({ error: 'Email and password required' });
    }

    if (users.has(email)) {
        return res.status(409).json({ error: 'User already exists' });
    }

    const userId = crypto.randomUUID();
    users.set(email, {
        id: userId,
        email,
        password: password, // In production, hash this with bcrypt
        firstName: firstName || '',
        lastName: lastName || '',
        createdAt: new Date()
    });

    req.session.userId = userId;
    req.session.email = email;

    res.json({
        success: true,
        message: 'Registration successful',
        userId,
        user: { email, firstName, lastName }
    });
});

app.post('/api/auth/login', (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
        return res.status(400).json({ error: 'Email and password required' });
    }

    const user = users.get(email);
    if (!user || user.password !== password) {
        return res.status(401).json({ error: 'Invalid credentials' });
    }

    req.session.userId = user.id;
    req.session.email = email;

    res.json({
        success: true,
        message: 'Login successful',
        userId: user.id,
        user: { email: user.email, firstName: user.firstName, lastName: user.lastName }
    });
});

app.get('/api/auth/logout', (req, res) => {
    req.session.destroy();
    res.json({ success: true, message: 'Logged out' });
});

app.get('/api/auth/me', (req, res) => {
    if (!req.session.userId) {
        return res.status(401).json({ error: 'Not authenticated' });
    }

    const user = Array.from(users.values()).find(u => u.id === req.session.userId);
    if (!user) {
        return res.status(404).json({ error: 'User not found' });
    }

    res.json({
        userId: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName
    });
});

// PRODUCT ENDPOINTS
app.get('/api/products/:code', async (req, res) => {
    const { code } = req.params;

    try {
        const url = `${process.env.SAP_OCC_BASE_URL}/${process.env.SAP_SITE_ID}/products/${code}`;
        const response = await axios.get(url, {
            params: {
                fields: 'DEFAULT,images(FULL),price(FULL),stock(FULL),description,reviews,averageRating'
            }
        });

        res.json(response.data);
    } catch (error) {
        console.error('Product fetch error:', error.message);
        res.status(500).json({ error: 'Failed to fetch product details' });
    }
});

// Reviews endpoint for a product
app.get('/api/products/:code/reviews', async (req, res) => {
    const { code } = req.params;

    try {
        const url = `${process.env.SAP_OCC_BASE_URL}/${process.env.SAP_SITE_ID}/products/${code}/reviews`;
        const response = await axios.get(url, {
            params: { lang: 'en', curr: 'USD' }
        });

        const reviews = response.data?.reviews || [];
        const averageRating = reviews.length ? (reviews.reduce((s, r) => s + (r.rating || 0), 0) / reviews.length) : 0;

        res.json({
            reviews,
            reviewsSummary: {
                count: reviews.length,
                averageRating: Math.round(averageRating * 100) / 100
            }
        });
    } catch (error) {
        console.error('Product reviews fetch error:', error.response?.data || error.message);
        res.status(500).json({ error: 'Failed to fetch product reviews' });
    }
});

// CART ENDPOINTS
app.get('/api/cart', async (req, res) => {
    try {
        const cartGuid = req.session.cartGuid;
        if (!cartGuid) {
            return res.json({ items: [], total: 0, guid: null });
        }

        const url = `${process.env.SAP_OCC_BASE_URL}/${process.env.SAP_SITE_ID}/users/anonymous/carts/${cartGuid}`;
        const response = await axios.get(url, {
            params: {
                fields: 'DEFAULT,entries(totalPrice(formattedValue),product(images(FULL),stock(FULL),name),basePrice(formattedValue,value),quantity),totalPrice(formattedValue),totalItems,totalPriceWithTax(formattedValue),totalDiscounts(value,formattedValue),subTotal(formattedValue),totalUnitCount,deliveryItemsQuantity,deliveryCost(formattedValue),totalTax(formattedValue,value),pickupItemsQuantity,net,appliedVouchers,productDiscounts(formattedValue),user,appliedOrderPromotions,appliedProductPromotions,potentialOrderPromotions,potentialProductPromotions',
                lang: 'en',
                curr: 'USD'
            }
        });

        res.json({
            guid: cartGuid,
            items: (response.data.entries || []).map(entry => ({
                id: entry.entryNumber,
                productCode: entry.product.code,
                productName: entry.product.name,
                price: parseFloat((entry.basePrice?.value) || 0),
                quantity: entry.quantity,
                totalPrice: entry.totalPrice?.formattedValue
            })),
            total: parseFloat((response.data.subTotal?.value) || 0),
            subtotal: response.data.subTotal?.formattedValue,
            tax: response.data.totalTax?.formattedValue,
            totalPrice: response.data.totalPrice?.formattedValue,
            totalItems: response.data.totalItems
        });
    } catch (error) {
        console.error('Cart fetch error:', error.response?.data || error.message);
        res.json({ items: [], total: 0, guid: null });
    }
});

app.post('/api/cart/add', async (req, res) => {
    const { productCode, productName, price, quantity } = req.body;

    if (!productCode || !quantity) {
        return res.status(400).json({ error: 'Product code and quantity required' });
    }

    try {
        // Get or create cart
        let cartGuid = req.session.cartGuid;
        
        if (!cartGuid) {
            // Create new anonymous cart
            const createCartUrl = `${process.env.SAP_OCC_BASE_URL}/${process.env.SAP_SITE_ID}/users/anonymous/carts`;
            
            console.log('[Cart] Creating new anonymous cart...');
            const cartResponse = await axios.post(createCartUrl, {}, {
                params: { 
                    fields: 'DEFAULT,entries(totalPrice(formattedValue),product(images(FULL),stock(FULL),name),basePrice(formattedValue,value),quantity),totalPrice(formattedValue),totalItems,totalPriceWithTax(formattedValue),totalDiscounts(value,formattedValue),subTotal(formattedValue),totalUnitCount,deliveryItemsQuantity,deliveryCost(formattedValue),totalTax(formattedValue,value),pickupItemsQuantity,net,appliedVouchers,productDiscounts(formattedValue),user,appliedOrderPromotions,appliedProductPromotions,potentialOrderPromotions,potentialProductPromotions',
                    lang: 'en', 
                    curr: 'USD' 
                }
            });
            
            cartGuid = cartResponse.data.guid; // Use guid, not code!
            req.session.cartGuid = cartGuid;
            console.log('[Cart] Created new cart with GUID:', cartGuid);
        }

        // Add entry to cart
        console.log(`[Cart] Adding product ${productCode} to cart ${cartGuid}`);
        const addEntryUrl = `${process.env.SAP_OCC_BASE_URL}/${process.env.SAP_SITE_ID}/users/anonymous/carts/${cartGuid}/entries`;
        const entryResponse = await axios.post(addEntryUrl, {
            product: { code: productCode },
            quantity: quantity
        }, {
            params: { lang: 'en', curr: 'USD' }
        });

        console.log('[Cart] Product added successfully, entry:', entryResponse.data.entry?.entryNumber);

        // Fetch updated cart
        const cartUrl = `${process.env.SAP_OCC_BASE_URL}/${process.env.SAP_SITE_ID}/users/anonymous/carts/${cartGuid}`;
        const updatedCartResponse = await axios.get(cartUrl, {
            params: {
                fields: 'DEFAULT,entries(totalPrice(formattedValue),product(images(FULL),stock(FULL),name),basePrice(formattedValue,value),quantity),totalPrice(formattedValue),totalItems,totalPriceWithTax(formattedValue),totalDiscounts(value,formattedValue),subTotal(formattedValue),totalUnitCount,deliveryItemsQuantity,deliveryCost(formattedValue),totalTax(formattedValue,value),pickupItemsQuantity,net,appliedVouchers,productDiscounts(formattedValue),user,appliedOrderPromotions,appliedProductPromotions,potentialOrderPromotions,potentialProductPromotions',
                lang: 'en',
                curr: 'USD'
            }
        });

        // Format cart data for frontend
        const cart = {
            guid: cartGuid,
            items: (updatedCartResponse.data.entries || []).map(entry => ({
                id: entry.entryNumber,
                productCode: entry.product.code,
                productName: entry.product.name,
                price: parseFloat((entry.basePrice?.value) || 0),
                quantity: entry.quantity,
                totalPrice: entry.totalPrice?.formattedValue
            })),
            total: parseFloat((updatedCartResponse.data.subTotal?.value) || 0),
            subtotal: updatedCartResponse.data.subTotal?.formattedValue,
            tax: updatedCartResponse.data.totalTax?.formattedValue,
            totalPrice: updatedCartResponse.data.totalPrice?.formattedValue,
            totalItems: updatedCartResponse.data.totalItems
        };

        res.json({
            success: true,
            message: 'Item added to cart',
            cart
        });
    } catch (error) {
        console.error('Add to cart error:', error.response?.data || error.message);
        res.status(500).json({ 
            error: 'Failed to add item to cart',
            details: error.response?.data?.errors?.[0]?.message || error.message
        });
    }
});

app.post('/api/cart/remove', async (req, res) => {
    const { itemId } = req.body;
    const cartGuid = req.session.cartGuid;

    if (!cartGuid) {
        return res.status(400).json({ error: 'No cart found' });
    }

    try {
        // Remove entry from cart
        console.log(`[Cart] Removing entry ${itemId} from cart ${cartGuid}`);
        const removeUrl = `${process.env.SAP_OCC_BASE_URL}/${process.env.SAP_SITE_ID}/users/anonymous/carts/${cartGuid}/entries/${itemId}`;
        await axios.delete(removeUrl, {
            params: { lang: 'en', curr: 'USD' }
        });

        // Fetch updated cart
        const cartUrl = `${process.env.SAP_OCC_BASE_URL}/${process.env.SAP_SITE_ID}/users/anonymous/carts/${cartGuid}`;
        const updatedCartResponse = await axios.get(cartUrl, {
            params: {
                fields: 'DEFAULT,entries(totalPrice(formattedValue),product(images(FULL),stock(FULL),name),basePrice(formattedValue,value),quantity),totalPrice(formattedValue),totalItems,totalPriceWithTax(formattedValue),totalDiscounts(value,formattedValue),subTotal(formattedValue),totalUnitCount,deliveryItemsQuantity,deliveryCost(formattedValue),totalTax(formattedValue,value),pickupItemsQuantity,net,appliedVouchers,productDiscounts(formattedValue),user,appliedOrderPromotions,appliedProductPromotions,potentialOrderPromotions,potentialProductPromotions',
                lang: 'en',
                curr: 'USD'
            }
        });

        const cart = {
            guid: cartGuid,
            items: (updatedCartResponse.data.entries || []).map(entry => ({
                id: entry.entryNumber,
                productCode: entry.product.code,
                productName: entry.product.name,
                price: parseFloat((entry.basePrice?.value) || 0),
                quantity: entry.quantity,
                totalPrice: entry.totalPrice?.formattedValue
            })),
            total: parseFloat((updatedCartResponse.data.subTotal?.value) || 0),
            subtotal: updatedCartResponse.data.subTotal?.formattedValue,
            tax: updatedCartResponse.data.totalTax?.formattedValue,
            totalPrice: updatedCartResponse.data.totalPrice?.formattedValue,
            totalItems: updatedCartResponse.data.totalItems
        };

        res.json({
            success: true,
            message: 'Item removed from cart',
            cart
        });
    } catch (error) {
        console.error('Remove from cart error:', error.response?.data || error.message);
        res.status(500).json({ 
            error: 'Failed to remove item from cart',
            details: error.response?.data?.errors?.[0]?.message || error.message
        });
    }
});

app.post('/api/cart/update', async (req, res) => {
    const { itemId, quantity } = req.body;
    const cartGuid = req.session.cartGuid;

    if (!cartGuid) {
        return res.status(400).json({ error: 'No cart found' });
    }

    try {
        // Update entry quantity
        console.log(`[Cart] Updating entry ${itemId} quantity to ${quantity}`);
        const updateUrl = `${process.env.SAP_OCC_BASE_URL}/${process.env.SAP_SITE_ID}/users/anonymous/carts/${cartGuid}/entries/${itemId}`;
        await axios.patch(updateUrl, {
            quantity: quantity
        }, {
            params: { lang: 'en', curr: 'USD' }
        });

        // Fetch updated cart
        const cartUrl = `${process.env.SAP_OCC_BASE_URL}/${process.env.SAP_SITE_ID}/users/anonymous/carts/${cartGuid}`;
        const updatedCartResponse = await axios.get(cartUrl, {
            params: {
                fields: 'DEFAULT,entries(totalPrice(formattedValue),product(images(FULL),stock(FULL),name),basePrice(formattedValue,value),quantity),totalPrice(formattedValue),totalItems,totalPriceWithTax(formattedValue),totalDiscounts(value,formattedValue),subTotal(formattedValue),totalUnitCount,deliveryItemsQuantity,deliveryCost(formattedValue),totalTax(formattedValue,value),pickupItemsQuantity,net,appliedVouchers,productDiscounts(formattedValue),user,appliedOrderPromotions,appliedProductPromotions,potentialOrderPromotions,potentialProductPromotions',
                lang: 'en',
                curr: 'USD'
            }
        });

        const cart = {
            guid: cartGuid,
            items: (updatedCartResponse.data.entries || []).map(entry => ({
                id: entry.entryNumber,
                productCode: entry.product.code,
                productName: entry.product.name,
                price: parseFloat((entry.basePrice?.value) || 0),
                quantity: entry.quantity,
                totalPrice: entry.totalPrice?.formattedValue
            })),
            total: parseFloat((updatedCartResponse.data.subTotal?.value) || 0),
            subtotal: updatedCartResponse.data.subTotal?.formattedValue,
            tax: updatedCartResponse.data.totalTax?.formattedValue,
            totalPrice: updatedCartResponse.data.totalPrice?.formattedValue,
            totalItems: updatedCartResponse.data.totalItems
        };

        res.json({
            success: true,
            message: 'Cart updated',
            cart
        });
    } catch (error) {
        console.error('Update cart error:', error.response?.data || error.message);
        res.status(500).json({ 
            error: 'Failed to update cart',
            details: error.response?.data?.errors?.[0]?.message || error.message
        });
    }
});

// SEARCH ENDPOINT
app.post('/api/search', async (req, res) => {
    const { query } = req.body;
    
    if (!query || query.trim() === '') {
        return res.status(400).json({ error: 'Query is required' });
    }

    try {
        const result = await runAgent(query);
        res.json(result);
    } catch (error) {
        res.status(500).json({
            error: error.message,
            response: 'An error occurred while processing your request'
        });
    }
});

// CHECKOUT/ORDER ENDPOINTS
app.post('/api/orders/create', requireAuth, (req, res) => {
    const { shippingAddress, billingAddress, paymentMethod } = req.body;

    const cart = carts.get(req.session.userId);
    if (!cart || cart.items.length === 0) {
        return res.status(400).json({ error: 'Cart is empty' });
    }

    if (!shippingAddress || !billingAddress) {
        return res.status(400).json({ error: 'Shipping and billing addresses required' });
    }

    const orderId = `ORD-${++orderCounter}`;
    const user = Array.from(users.values()).find(u => u.id === req.session.userId);

    const order = {
        id: orderId,
        userId: req.session.userId,
        userEmail: user.email,
        userName: `${user.firstName} ${user.lastName}`,
        items: [...cart.items],
        subtotal: cart.total,
        tax: Math.round(cart.total * 0.08 * 100) / 100, // 8% tax
        shipping: cart.total > 100 ? 0 : 10, // Free shipping over $100
        total: 0,
        shippingAddress,
        billingAddress,
        paymentMethod,
        status: 'PENDING',
        createdAt: new Date(),
        updatedAt: new Date()
    };

    order.total = order.subtotal + order.tax + order.shipping;
    orders.set(orderId, order);

    // Clear cart after order
    carts.delete(req.session.userId);

    res.json({
        success: true,
        message: 'Order created successfully',
        orderId,
        order
    });
});

app.get('/api/orders/:orderId', requireAuth, (req, res) => {
    const order = orders.get(req.params.orderId);

    if (!order) {
        return res.status(404).json({ error: 'Order not found' });
    }

    if (order.userId !== req.session.userId) {
        return res.status(403).json({ error: 'Unauthorized' });
    }

    res.json(order);
});

app.get('/api/orders', requireAuth, (req, res) => {
    const userOrders = Array.from(orders.values()).filter(
        order => order.userId === req.session.userId
    );

    res.json({
        orders: userOrders,
        total: userOrders.length
    });
});

/**
 * 4. Start Server
 */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`\n🚀 SAP AI Agent is running at http://localhost:${PORT}`);
    console.log(`Open your browser and navigate to http://localhost:${PORT}\n`);
});
