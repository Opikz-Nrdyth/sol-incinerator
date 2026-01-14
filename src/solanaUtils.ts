import {
  Connection,
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  createMint,
  createAssociatedTokenAccount,
  closeAccount,
  getAccount,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";

// --- UTILITIES: RATE LIMIT HANDLER ---

// 1. Fungsi Tidur (Jeda Waktu)
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// 2. Fungsi Wrapper Anti-429 (Retry Logic)
// Ini akan membungkus request RPC. Jika kena limit (429), dia akan tunggu & coba lagi.
async function safeRPCRequest<T>(
  operation: () => Promise<T>,
  retries = 5,
  delay = 2000
): Promise<T> {
  for (let i = 0; i < retries; i++) {
    try {
      return await operation();
    } catch (error: any) {
      const msg = error.message || JSON.stringify(error);
      // Cek apakah errornya 429 (Too Many Requests)
      if (msg.includes("429") || msg.includes("Too many requests")) {
        const waitTime = delay * (i + 1); // Exponential Backoff (2s, 4s, 6s...)
        console.warn(
          `⚠️ RPC Limit (429). Menunggu ${waitTime}ms sebelum coba lagi...`
        );
        await sleep(waitTime);
      } else {
        throw error; // Jika error lain (misal saldo kurang), langsung throw
      }
    }
  }
  throw new Error("Gagal request ke RPC setelah 5x percobaan (Limit Penuh).");
}

// --- FUNGSI UTAMA ---

export const getActiveTokens = async (
  connection: Connection,
  payer: Keypair
) => {
  try {
    console.log(`🔍 Fetching active tokens...`);

    // Gunakan safeRPCRequest agar tidak error saat fetch akun
    const accountsStandard = await safeRPCRequest(() =>
      connection.getParsedTokenAccountsByOwner(payer.publicKey, {
        programId: TOKEN_PROGRAM_ID,
      })
    );

    const accounts2022 = await safeRPCRequest(() =>
      connection.getParsedTokenAccountsByOwner(payer.publicKey, {
        programId: TOKEN_2022_PROGRAM_ID,
      })
    );

    const allAccounts = [...accountsStandard.value, ...accounts2022.value];

    const activeAccounts = allAccounts.filter((acc) => {
      return acc.account.data.parsed.info.tokenAmount.uiAmount > 0;
    });

    if (activeAccounts.length === 0) {
      return { success: true, positions: [] };
    }

    // Ambil Harga (Chunking: Pecah jadi 30 token per request agar URL tidak kepanjangan)
    const mintAddresses = activeAccounts.map(
      (acc) => acc.account.data.parsed.info.mint
    );
    const chunkSize = 30;
    let prices: any = {};

    for (let i = 0; i < mintAddresses.length; i += chunkSize) {
      const chunk = mintAddresses.slice(i, i + chunkSize).join(",");
      try {
        // Fetch harga tidak perlu safeRPCRequest yang berat, cukup try-catch biasa
        const response = await fetch(
          `https://api.jup.ag/price/v2?ids=${chunk}`
        );
        const data: any = await response.json();
        prices = { ...prices, ...(data.data || {}) };
        await sleep(500); // Jeda dikit antar fetch harga
      } catch (e) {
        console.error("⚠️ Gagal ambil sebagian harga.");
      }
    }

    const positions = activeAccounts.map((acc) => {
      const info = acc.account.data.parsed.info;
      const mint = info.mint;
      const amount = info.tokenAmount.uiAmount;

      const priceData = prices[mint];
      const priceUsd = priceData ? parseFloat(priceData.price) : 0;
      const valueUsd = amount * priceUsd;

      return {
        mint: mint,
        tokenAccount: acc.pubkey.toBase58(),
        amount: amount,
        decimals: info.tokenAmount.decimals,
        priceUsd: priceUsd,
        valueUsd: valueUsd,
      };
    });

    positions.sort((a, b) => b.valueUsd - a.valueUsd);

    return { success: true, positions: positions };
  } catch (error: any) {
    console.error("Error fetching positions:", error.message);
    throw new Error(error.message);
  }
};

export const getWalletBalance = async (
  connection: Connection,
  publicKey: PublicKey
) => {
  try {
    // Safe RPC untuk Get Balance
    const lamports = await safeRPCRequest(() =>
      connection.getBalance(publicKey)
    );
    const solBalance = lamports / LAMPORTS_PER_SOL;

    let priceUsd = 0;
    let priceIdr = 0;

    try {
      const response = await fetch(
        "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd,idr"
      );
      const data: any = await response.json();
      priceUsd = data.solana?.usd || 0;
      priceIdr = data.solana?.idr || 0;
    } catch (err) {}

    return {
      success: true,
      balance: { sol: solBalance, sol_string: `${solBalance.toFixed(5)} SOL` },
      marketPrice: { usd: priceUsd, idr: priceIdr },
      estimatedValue: {
        usd: new Intl.NumberFormat("en-US", {
          style: "currency",
          currency: "USD",
        }).format(solBalance * priceUsd),
        idr: new Intl.NumberFormat("id-ID", {
          style: "currency",
          currency: "IDR",
        }).format(solBalance * priceIdr),
      },
    };
  } catch (error: any) {
    throw new Error(error.message);
  }
};

// --- FUNGSI AUTO CLEAN DENGAN JEDA (THROTTLING) ---
export const closeAllEmptyAccounts = async (
  connection: Connection,
  payer: Keypair
) => {
  try {
    console.log(`🔍 Scanning for dust accounts...`);

    // 1. Scan dengan Safe RPC
    const accountsStandard = await safeRPCRequest(() =>
      connection.getParsedTokenAccountsByOwner(payer.publicKey, {
        programId: TOKEN_PROGRAM_ID,
      })
    );
    const accounts2022 = await safeRPCRequest(() =>
      connection.getParsedTokenAccountsByOwner(payer.publicKey, {
        programId: TOKEN_2022_PROGRAM_ID,
      })
    );

    const allAccounts = [
      ...accountsStandard.value.map((a) => ({
        ...a,
        programId: TOKEN_PROGRAM_ID,
      })),
      ...accounts2022.value.map((a) => ({
        ...a,
        programId: TOKEN_2022_PROGRAM_ID,
      })),
    ];

    let closedCount = 0;
    let totalRefund = 0;
    const results = [];

    // 2. Loop & Eksekusi dengan Jeda
    for (const account of allAccounts) {
      const tokenAmount = account.account.data.parsed.info.tokenAmount;

      // Cek saldo 0
      if (tokenAmount.uiAmount === 0 || tokenAmount.amount === "0") {
        const programId = account.programId;
        const addr = account.pubkey.toBase58();

        try {
          console.log(`🔥 Closing ${addr}...`);

          // Eksekusi Close Account
          // Kita bungkus juga dengan Safe RPC untuk transaksi send
          const signature = await safeRPCRequest(() =>
            closeAccount(
              connection,
              payer,
              account.pubkey,
              payer.publicKey,
              payer,
              [],
              { commitment: "confirmed" },
              programId
            )
          );

          closedCount++;
          totalRefund += 0.00203928;
          results.push({ address: addr, status: "Closed", signature });

          console.log(`✅ Closed! Jeda 1 detik...`);
          // PENTING: Jeda 1 detik agar tidak dianggap SPAM oleh RPC
          await sleep(1000);
        } catch (err: any) {
          console.error(`❌ Gagal: ${err.message}`);
          results.push({ address: addr, status: "Failed", error: err.message });
          // Kalau gagal, jeda lebih lama (2 detik) sebelum lanjut
          await sleep(2000);
        }
      }
    }
    return {
      success: true,
      summary: {
        found: allAccounts.length,
        closed: closedCount,
        estimatedRefundSOL: totalRefund,
      },
      details: results,
    };
  } catch (error: any) {
    throw new Error(error.message);
  }
};

export const checkEmptyAccounts = async (
  connection: Connection,
  payer: Keypair
) => {
  try {
    // Gunakan Safe RPC untuk Scan
    const accountsStandard = await safeRPCRequest(() =>
      connection.getParsedTokenAccountsByOwner(payer.publicKey, {
        programId: TOKEN_PROGRAM_ID,
      })
    );
    const accounts2022 = await safeRPCRequest(() =>
      connection.getParsedTokenAccountsByOwner(payer.publicKey, {
        programId: TOKEN_2022_PROGRAM_ID,
      })
    );

    const allAccounts = [
      ...accountsStandard.value.map((a) => ({ ...a, programId: "SPL Token" })),
      ...accounts2022.value.map((a) => ({ ...a, programId: "Token-2022" })),
    ];

    const emptyAccounts = [];
    let potentialRefund = 0;

    for (const account of allAccounts) {
      const tokenAmount = account.account.data.parsed.info.tokenAmount;
      if (tokenAmount.uiAmount === 0 || tokenAmount.amount === "0") {
        potentialRefund += 0.00203928;
        emptyAccounts.push({
          address: account.pubkey.toBase58(),
          mint: account.account.data.parsed.info.mint,
          program: account.programId,
          potentialRefund: `~0.00204 SOL`,
        });
      }
    }
    return {
      success: true,
      network: connection.rpcEndpoint.includes("devnet") ? "Devnet" : "Mainnet",
      summary: {
        emptyAccountsFound: emptyAccounts.length,
        totalPotentialRefund: `${potentialRefund.toFixed(5)} SOL`,
      },
      details: emptyAccounts,
    };
  } catch (error: any) {
    throw new Error(error.message);
  }
};

// Fungsi dummy createToken agar tidak error di main.ts jika masih ada import lama
export const createNewToken = async (
  connection: Connection,
  payer: Keypair
) => {
  return { success: true };
};
