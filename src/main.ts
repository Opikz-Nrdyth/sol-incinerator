import express, { Request, Response, NextFunction } from "express";
import { Connection, Keypair } from "@solana/web3.js";
import dotenv from "dotenv";
import {
  closeAllEmptyAccounts,
  checkEmptyAccounts,
  getWalletBalance,
  getActiveTokens,
} from "./solanaUtils";
import {
  generateEthWallet,
  generateBtcWallet,
  generateTonWallet,
  getBtcAddressFromKey,
} from "./multiGenerator";
import { sendEth, sendTon, sendBtc, sendSol } from "./multiSender";
import {
  getEthBalance,
  getBtcBalance,
  getTonBalance,
  getSolBalance,
} from "./multiBalance";
import { generateNewWallet } from "./walletGenerator";
import bs58 from "bs58";
import cors from "cors";
import path from "path";
import fs from "fs";

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

const RPC_URL = process.env.RPC_URL || "https://api.devnet.solana.com";
const connection = new Connection(RPC_URL, "confirmed");

// --- SETUP WALLET ---
let wallet: Keypair | null = null; // Default null jika belum ada key
let isWalletConfigured = false;

function loadWallet() {
  if (process.env.PRIVATE_KEY) {
    try {
      let secretKey: Uint8Array;
      const pkString = process.env.PRIVATE_KEY.trim();

      if (pkString.length === 0) throw new Error("Key Kosong");

      // Cek format: Array atau Base58
      if (pkString.startsWith("[") && pkString.endsWith("]")) {
        secretKey = Uint8Array.from(JSON.parse(pkString));
      } else {
        secretKey = bs58.decode(pkString);
      }

      wallet = Keypair.fromSecretKey(secretKey);
      isWalletConfigured = true;
      console.log("✅ Wallet BERHASIL dimuat:", wallet.publicKey.toBase58());
    } catch (e) {
      console.error("❌ Gagal memuat Private Key. Mode Setup Aktif.");
      wallet = null;
      isWalletConfigured = false;
    }
  } else {
    console.warn(
      "⚠️ PRIVATE_KEY tidak ditemukan di .env. Masuk ke Mode Setup."
    );
    wallet = null;
    isWalletConfigured = false;
  }
}

// Jalankan load saat start
loadWallet();

// --- MIDDLEWARE PENJAGA (GUARD) ---
const requireWallet = (req: Request, res: Response, next: NextFunction) => {
  if (!isWalletConfigured || !wallet) {
    return res.status(401).json({
      success: false,
      error: "Wallet Solana belum dikonfigurasi. Silakan buat wallet baru.",
      redirect: "/portfolio",
    });
  }
  next();
};

// --- ROUTES ---

// 1. Halaman Utama (Dashboard)
app.get("/", (req: Request, res: Response) => {
  // LOGIKA REDIRECT: Jika belum ada wallet, lempar ke /create-wallet
  if (!isWalletConfigured) {
    return res.redirect("/portfolio");
  }
  const htmlPath = path.join(process.cwd(), "index.html");
  res.sendFile(htmlPath);
});

// 2. Halaman Create Wallet (Selalu bisa diakses)
app.get("/create-wallet", (req: Request, res: Response) => {
  const htmlPath = path.join(process.cwd(), "create-wallet.html");
  res.sendFile(htmlPath);
});

// 3. API Create Wallet (Public)
app.get("/api/create-wallet", (req: Request, res: Response) => {
  try {
    const result = generateNewWallet();
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 4. API Set Wallet (Public)
app.post("/api/use-wallet", (req: Request, res: Response) => {
  const { secretKey } = req.body;

  if (!secretKey) {
    return res
      .status(400)
      .json({ success: false, error: "Private Key tidak ada." });
  }

  try {
    const envPath = path.join(process.cwd(), ".env");
    let envContent = "";

    if (fs.existsSync(envPath)) {
      envContent = fs.readFileSync(envPath, "utf8");
    }

    const keyLabel = "PRIVATE_KEY=";
    const newLine = `${keyLabel}${secretKey}`;

    if (envContent.includes(keyLabel)) {
      envContent = envContent.replace(/^PRIVATE_KEY=.*$/m, newLine);
    } else {
      // Pastikan ada baris baru sebelum nulis kalau file tidak kosong dan tidak diakhiri newline
      const prefix =
        envContent.length > 0 && !envContent.endsWith("\n") ? "\n" : "";
      envContent += `${prefix}${newLine}`;
    }

    fs.writeFileSync(envPath, envContent);
    console.log("✅ .env berhasil diupdate.");

    // Reload wallet variable di memori tanpa perlu restart manual proses node
    // (Tapi restart lebih aman untuk memastikan env bersih)
    process.env.PRIVATE_KEY = secretKey;
    loadWallet();

    res.json({
      success: true,
      message: "Wallet tersimpan! Redirecting...",
    });
  } catch (error: any) {
    console.error("Gagal update .env:", error);
    res.status(500).json({ success: false, error: "Gagal menulis file .env" });
  }
});

// --- API ROUTES YANG BUTUH WALLET (PROTECTED) ---

app.get("/status", requireWallet, (req: Request, res: Response) => {
  res.send({
    status: "Running",
    wallet: wallet!.publicKey.toBase58(), // Tanda seru (!) karena kita yakin tidak null berkat middleware
    network: RPC_URL,
  });
});

app.get("/balance", requireWallet, async (req: Request, res: Response) => {
  try {
    const result = await getWalletBalance(connection, wallet!.publicKey);
    res.json({ ...result, wallet: wallet!.publicKey.toBase58() });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post(
  "/close-wallet",
  requireWallet,
  async (req: Request, res: Response) => {
    try {
      const result = await closeAllEmptyAccounts(connection, wallet!);
      res.json(result);
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  }
);

app.post("/cek-wallet", requireWallet, async (req: Request, res: Response) => {
  try {
    const result = await checkEmptyAccounts(connection, wallet!);
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get("/positions", requireWallet, async (req: Request, res: Response) => {
  try {
    const result = await getActiveTokens(connection, wallet!);
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ---------------------- Portofolio ----------------------
const updateEnvFile = (key: string, value: string) => {
  try {
    const envPath = path.join(process.cwd(), ".env");
    let envContent = "";
    if (fs.existsSync(envPath)) {
      envContent = fs.readFileSync(envPath, "utf8");
    }

    const newLine = `${key}=${value}`;

    // Regex untuk mencari Key specific (misal ETH_PRIVATE_KEY=...)
    // Flags: 'm' (multiline)
    const regex = new RegExp(`^${key}=.*$`, "m");

    if (regex.test(envContent)) {
      // Replace jika sudah ada
      envContent = envContent.replace(regex, newLine);
    } else {
      // Append jika belum ada
      const prefix =
        envContent.length > 0 && !envContent.endsWith("\n") ? "\n" : "";
      envContent += `${prefix}${newLine}`;
    }

    fs.writeFileSync(envPath, envContent);
    // Update process.env di memory agar langsung berefek (kecuali untuk library yg butuh restart)
    process.env[key] = value;
    return true;
  } catch (e) {
    console.error(e);
    return false;
  }
};

app.get("/api/multichain/status", async (req: Request, res: Response) => {
  const status = {
    sol: { connected: false, address: "", balance: "0" },
    eth: { connected: false, address: "", balance: "0" },
    btc: { connected: false, address: "", balance: "0" },
    ton: { connected: false, address: "", balance: "0" },
  };

  if (process.env.PRIVATE_KEY) {
    status.sol.connected = true;
    const data = await getSolBalance(process.env.PRIVATE_KEY);
    status.sol.address = data.address;
    status.sol.balance = data.balance;
  }

  // Cek ETH
  if (process.env.ETH_PRIVATE_KEY) {
    status.eth.connected = true;
    const data = await getEthBalance(process.env.ETH_PRIVATE_KEY);
    status.eth.address = data.address;
    status.eth.balance = data.balance;
  }

  // Cek BTC
  if (process.env.BTC_ADDRESS) {
    // Untuk BTC kita simpan Address & Key terpisah biar gampang cek saldo
    status.btc.connected = true;
    status.btc.address = process.env.BTC_ADDRESS;
    // Cek saldo realtime
    const data = await getBtcBalance(process.env.BTC_ADDRESS);
    status.btc.balance = data.balance.toString();
  }

  // Cek TON
  if (process.env.TON_MNEMONIC) {
    status.ton.connected = true;
    const data = await getTonBalance(process.env.TON_MNEMONIC);
    status.ton.address = data.address;
    status.ton.balance = data.balance.toString();
  }

  res.json(status);
});

app.post("/api/multichain/create", async (req: Request, res: Response) => {
  const { type } = req.body;

  try {
    if (type === "eth") {
      const wallet = generateEthWallet();
      updateEnvFile("ETH_PRIVATE_KEY", wallet.privateKey);
      res.json({ success: true, message: "ETH Wallet created & saved!" });
    } else if (type === "btc") {
      const wallet = generateBtcWallet();
      // BTC butuh address buat cek saldo API public, jadi simpan dua-duanya
      updateEnvFile("BTC_PRIVATE_KEY", wallet.privateKey);
      updateEnvFile("BTC_ADDRESS", wallet.address);
      res.json({ success: true, message: "BTC Wallet created & saved!" });
    } else if (type === "ton") {
      const wallet = await generateTonWallet();
      updateEnvFile("TON_MNEMONIC", wallet.mnemonic);
      res.json({ success: true, message: "TON Wallet created & saved!" });
    } else {
      res
        .status(400)
        .json({ success: false, error: "Tipe coin tidak dikenal" });
    }
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post("/api/multichain/send", async (req: Request, res: Response) => {
  const { type, to, amount } = req.body;

  // Validasi Input Dasar
  if (!to || !amount) {
    return res
      .status(400)
      .json({ success: false, error: "Alamat dan Jumlah wajib diisi." });
  }

  try {
    let result;

    // LOGIKA KIRIM ETH
    if (type === "eth") {
      const pk = process.env.ETH_PRIVATE_KEY;
      if (!pk)
        return res
          .status(400)
          .json({ success: false, error: "Wallet ETH belum dibuat!" });

      result = await sendEth(pk, to, amount);
    }
    // LOGIKA KIRIM SOL
    else if (type === "sol") {
      const pk = process.env.PRIVATE_KEY;
      if (!pk)
        return res
          .status(400)
          .json({ success: false, error: "Wallet Solana belum ada!" });
      result = await sendSol(pk, to, amount);
    }
    // LOGIKA KIRIM TON
    else if (type === "ton") {
      const mnemonic = process.env.TON_MNEMONIC; // Pastikan env kamu namanya TON_MNEMONIC (sesuai generator terakhir)
      // Jika kamu pakai TON_PRIVATE_KEY, kode sender harus disesuaikan sedikit.
      // Asumsi kita pakai Mnemonic agar aman & standar.
      if (!mnemonic)
        return res
          .status(400)
          .json({ success: false, error: "Wallet TON belum dibuat!" });

      result = await sendTon(mnemonic, to, amount);
    }
    // LOGIKA BITCOIN (Skip dulu karena rumit)
    else if (type === "btc") {
      const pk = process.env.BTC_PRIVATE_KEY;
      if (!pk)
        return res
          .status(400)
          .json({ success: false, error: "Wallet BTC belum dibuat!" });

      // Validasi alamat tujuan (Harus valid Mainnet)
      if (!to.startsWith("1") && !to.startsWith("3") && !to.startsWith("bc1")) {
        return res.status(400).json({
          success: false,
          error: "Alamat BTC tidak valid (Gunakan format bc1/1/3)",
        });
      }

      result = await sendBtc(pk, to, amount);
    } else {
      return res
        .status(400)
        .json({ success: false, error: "Tipe coin tidak dikenal." });
    }

    res.json(result);
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post("/api/multichain/import", async (req: Request, res: Response) => {
  const { type, secret } = req.body;

  if (!secret || secret.trim() === "") {
    return res
      .status(400)
      .json({ success: false, error: "Private Key/Seed tidak boleh kosong" });
  }

  try {
    if (type === "eth") {
      // Validasi simpel: Key ETH harus dimulai 0x atau panjang 64 heksadesimal
      if (!secret.startsWith("0x") && secret.length !== 64) {
        return res
          .status(400)
          .json({ success: false, error: "Format Private Key ETH salah" });
      }
      // Simpan
      updateEnvFile("ETH_PRIVATE_KEY", secret);
      res.json({ success: true, message: "ETH Wallet berhasil diimpor!" });
    } else if (type === "sol") {
      updateEnvFile("PRIVATE_KEY", secret);
      res.json({ success: true, message: "Solana Wallet berhasil diimpor!" });
    } else if (type === "btc") {
      const address = getBtcAddressFromKey(secret);
      updateEnvFile("BTC_PRIVATE_KEY", secret);
      updateEnvFile("BTC_ADDRESS", address!);
      res.json({ success: true, message: "BTC Wallet berhasil diimpor!" });
    } else if (type === "ton") {
      const cleanMnemonic = secret.trim();
      if (cleanMnemonic.split(" ").length !== 24) {
        return res
          .status(400)
          .json({ success: false, error: "TON wajib 24 kata (Seed Phrase)" });
      }
      updateEnvFile("TON_MNEMONIC", cleanMnemonic);
      res.json({ success: true, message: "TON Wallet berhasil diimpor!" });
    } else {
      res
        .status(400)
        .json({ success: false, error: "Tipe coin tidak dikenal" });
    }
  } catch (e: any) {
    res
      .status(500)
      .json({ success: false, error: "Gagal Import: " + e.message });
  }
});

app.get("/portfolio", (req: Request, res: Response) => {
  res.sendFile(path.join(process.cwd(), "portfolio.html"));
});

// Start Server
app.listen(PORT, () => {
  console.log(`🚀 Server berjalan di http://localhost:${PORT}`);
  if (isWalletConfigured && wallet) {
    console.log(`💳 Wallet Public Key: ${wallet.publicKey.toBase58()}`);
  } else {
    console.log(
      `⚠️ Wallet belum diset. Silakan buka http://localhost:${PORT} untuk setup.`
    );
  }
});
