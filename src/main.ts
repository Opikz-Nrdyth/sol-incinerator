import express, { Request, Response } from "express";
import { Connection, Keypair } from "@solana/web3.js";
import dotenv from "dotenv";
import {
  closeAllEmptyAccounts,
  checkEmptyAccounts,
  getWalletBalance,
  getActiveTokens,
} from "./solanaUtils";
import bs58 from "bs58";
import cors from "cors";
import path from "path";

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

const RPC_URL = process.env.RPC_URL || "https://api.devnet.solana.com";
const connection = new Connection(RPC_URL, "confirmed");

// Setup Wallet Utama
let wallet: Keypair;

if (process.env.PRIVATE_KEY) {
  try {
    let secretKey: Uint8Array;
    const pkString = process.env.PRIVATE_KEY.trim();

    // Cek format: Apakah Array "[1,2,3]" atau Base58 String "5twc..."
    if (pkString.startsWith("[") && pkString.endsWith("]")) {
      // Format Array (JSON)
      secretKey = Uint8Array.from(JSON.parse(pkString));
    } else {
      // Format Base58 (Phantom/Solflare Export)
      secretKey = bs58.decode(pkString);
    }

    wallet = Keypair.fromSecretKey(secretKey);
    console.log("✅ Wallet BERHASIL dimuat:", wallet.publicKey.toBase58());
  } catch (e) {
    console.error("❌ Gagal memuat Private Key. Pastikan format benar.");
    console.error(e);
    wallet = Keypair.generate();
  }
} else {
  console.warn(
    "⚠️ WARNING: Menggunakan Wallet Sementara (Generated). Saldo akan hilang saat restart."
  );
}

// --- ROUTES ---

app.get("/", (req: Request, res: Response) => {
  // Mengambil file index.html dari folder root proyek
  const htmlPath = path.join(process.cwd(), "index.html");
  res.sendFile(htmlPath);
});

app.get("/status", (req: Request, res: Response) => {
  res.send({
    status: "Running",
    wallet: wallet.publicKey.toBase58(),
    network: RPC_URL,
  });
});

app.get("/balance", async (req: Request, res: Response) => {
  try {
    const result = await getWalletBalance(connection, wallet.publicKey);
    res.json({
      ...result,
      wallet: wallet.publicKey.toBase58(),
    });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post("/close-wallet", async (req: Request, res: Response) => {
  try {
    const result = await closeAllEmptyAccounts(connection, wallet);
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post("/cek-wallet", async (req: Request, res: Response) => {
  try {
    const result = await checkEmptyAccounts(connection, wallet);
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get("/positions", async (req: Request, res: Response) => {
  try {
    const result = await getActiveTokens(connection, wallet);
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Start Server
app.listen(PORT, () => {
  console.log(`🚀 Server berjalan di http://localhost:${PORT}`);
  console.log(`💳 Wallet Public Key: ${wallet.publicKey.toBase58()}`);
});
