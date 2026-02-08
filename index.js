import 'dotenv/config';
import { GoogleGenAI } from "@google/genai";
import axios from "axios";

const client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite';

/**
 * 1. SAP OCC API Connector
 * This function handles the actual communication with SAP.
 */
async function searchSAPProducts(query) {
    console.log(`\x1b[33m[SAP API]\x1b[0m Searching for: ${query}...`);
    try {
        const url = `${process.env.SAP_OCC_BASE_URL}/${process.env.SAP_SITE_ID}/products/search`;
        const response = await axios.get(url, {
            params: {
                query: query,
                fields: 'products(name,price(formattedValue),code,stock(stockLevelStatus))',
                pageSize: 3
            }
        });

        if (!response.data.products) return "No products found.";
        
        return JSON.stringify(response.data.products);
    } catch (error) {
        console.error("SAP API Error:", error.message);
        return "Error connecting to SAP Commerce Cloud.";
    }
}

/**
 * 2. System Prompt
 * Tells the AI how to behave and when to search for products.
 */

/**
 * 3. The Agent Loop
 * Orchestrates the conversation between the user, Google Gemini, and SAP.
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

        // Step B: Check if AI wants to search SAP
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

            console.log("\n\x1b[32m[Agent]:\x1b[0m", refinedResponse.candidates[0]?.content?.parts[0]?.text);
        } else {
            console.log("\n\x1b[32m[Agent]:\x1b[0m", assistantResponse);
        }
    } catch (error) {
        console.error("\x1b[31m[Error]:\x1b[0m", error.message);
        if (error.message.includes("401") || error.message.includes("API")) {
            console.log("\x1b[33mMake sure your GEMINI_API_KEY is set correctly in .env\x1b[0m");
        }
    }
}

// --- TEST RUN ---
const userQuery = process.argv[2] || "I am looking for a high-end camera";
runAgent(userQuery);