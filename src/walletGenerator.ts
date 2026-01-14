import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

export const generateNewWallet = () => {
  try {
    // 1. Generate Random Keypair
    const keypair = Keypair.generate();

    // 2. Format Output
    return {
      success: true,
      publicKey: keypair.publicKey.toBase58(),
      // Kita encode ke Base58 agar mudah di-import ke Phantom/Solflare
      secretKey: bs58.encode(keypair.secretKey),
      // Opsional: Kirim format Array juga jika butuh (untuk developer)
      secretKeyArray: Array.from(keypair.secretKey),
    };
  } catch (error: any) {
    console.error("Gagal generate wallet:", error);
    throw new Error("Gagal membuat wallet baru.");
  }
};
