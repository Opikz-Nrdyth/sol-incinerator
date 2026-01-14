import { ethers } from "ethers";
import * as bitcoin from "bitcoinjs-lib";
import { ECPairFactory } from "ecpair";
import * as ecc from "tiny-secp256k1";
import { mnemonicNew, mnemonicToWalletKey } from "@ton/crypto";
import { WalletContractV5R1 } from "@ton/ton";

const ECPair = ECPairFactory(ecc);

// Generator ETH
export const generateEthWallet = () => {
  const wallet = ethers.Wallet.createRandom();
  return {
    address: wallet.address,
    privateKey: wallet.privateKey,
  };
};

// Generator BTC (Native Segwit)
export const generateBtcWallet = () => {
  const keyPair = ECPair.makeRandom();
  const { address } = bitcoin.payments.p2wpkh({
    pubkey: keyPair.publicKey,
    network: bitcoin.networks.bitcoin,
  });
  return {
    address: address!,
    privateKey: keyPair.toWIF(),
  };
};

// Generator TON
export const generateTonWallet = async () => {
  const mnemonics = await mnemonicNew();
  const keyPair = await mnemonicToWalletKey(mnemonics);
  const secretKeyHex = Buffer.from(keyPair.secretKey).toString("hex");
  const wallet = WalletContractV5R1.create({
    workchain: 0,
    publicKey: keyPair.publicKey,
  });
  const address = wallet.address.toString({
    testOnly: false,
    urlSafe: true,
    bounceable: false,
  });

  return {
    address: address,
    mnemonic: mnemonics.join(" "),
    privateKey: secretKeyHex,
  };
};

export const getBtcAddressFromKey = (wif: string) => {
  try {
    const keyPair = ECPair.fromWIF(wif, bitcoin.networks.bitcoin);
    const { address } = bitcoin.payments.p2wpkh({
      pubkey: keyPair.publicKey,
      network: bitcoin.networks.bitcoin,
    });
    return address;
  } catch (e) {
    throw new Error("Private Key Bitcoin tidak valid (Gunakan format WIF)");
  }
};

// 2. Helper untuk Validasi Mnemonic TON
export const validateTonMnemonic = async (mnemonic: string) => {
  const words = mnemonic.split(" ");
  if (words.length !== 24) throw new Error("Seed Phrase TON harus 24 kata!");
  return true;
};
