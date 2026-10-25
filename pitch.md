# Undo: pitch

**Scammers rush. Undo makes them wait.**

## The problem
Americans 60+ reported $7.7 billion lost to scams in 2025 (FBI IC3), about 60% more than 2024, and most fraud never gets reported. The scripts all work the same way: panic, secrecy, and "right now." Once the gift cards or the crypto are sent, the money's gone.

## What Undo does
Any large payment goes into a vault on Solana instead of leaving right away.
1. **The money waits:** 24 hours (1 hour if it looks normal).
2. **We explain why:** scam-pattern scan + Snowflake scam reports + a plain-English explanation from Vultr AI, quoting the exact words that look like a scam.
3. **Family gets a text** and can stop it with one tap, or approve it if it's real.

Grandma never loses control of her own money. After the hold she can always send it. Undo just makes sure nobody can rush her.

## Why it's real
- Our own Rust program on Solana enforces the rules. Even if our server got hacked, the money can't leave early, can't go to anyone but the original payee, and refunds only go back to her.
- We show it live: "Send now" gets refused on-chain, and three attacks (scammer withdraws, early release, redirect) fail as real devnet transactions.
- Every decision gets a SHA-256 receipt in the transaction memo, and the browser verifies it straight from Solana.
- The scammer's message is treated as hostile input: hidden characters stripped, prompt-injection attempts flagged, and the AI can only raise the risk, never lower it.

## Sponsor tech
- **Solana:** vault program, PDAs, memo receipts, on-chain attack demos
- **Vultr:** hosting + Serverless Inference for the explanations
- **Snowflake:** scam reports and outcome logging
- **Twilio:** texts to the trusted contact

## What's next
USDC instead of devnet SOL, an opt-in "safe account" for banks and credit unions, family-set limits, multiple trusted contacts, and learning from real stopped scams.
