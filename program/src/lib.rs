//! Pause: a cooling-off vault for large payments.
//!
//! When a senior sends a large payment, the money waits in a vault (a PDA owned
//! by this program) instead of leaving right away. The rules:
//!   * release to the payee: the family guardian can approve any time;
//!     the senior alone only after the hold ends. Nobody can rush it.
//!   * cancel back to the senior: the senior or the guardian, any time.
//! The money can never go anywhere except the payee or back to the senior.
//! (Field names: client = senior, freelancer = payee, judge = guardian.)

use solana_program::{
    account_info::{next_account_info, AccountInfo},
    clock::Clock,
    entrypoint,
    entrypoint::ProgramResult,
    msg,
    program::invoke_signed,
    program_error::ProgramError,
    pubkey::Pubkey,
    rent::Rent,
    system_instruction, system_program,
    sysvar::Sysvar,
};

entrypoint!(process_instruction);

pub const DEAL_LEN: usize = 1 + 32 * 3 + 8 + 8 + 8 + 1; // 122 bytes

pub const STATE_FUNDED: u8 = 1;
pub const STATE_RELEASED: u8 = 2;
pub const STATE_REFUNDED: u8 = 3;

#[derive(Debug, Clone, PartialEq)]
pub struct Deal {
    pub state: u8,
    pub client: Pubkey,
    pub freelancer: Pubkey,
    pub judge: Pubkey,
    pub amount: u64,
    pub deadline: i64,
    pub deal_id: u64,
    pub bump: u8,
}

impl Deal {
    pub fn pack(&self, dst: &mut [u8]) {
        dst[0] = self.state;
        dst[1..33].copy_from_slice(self.client.as_ref());
        dst[33..65].copy_from_slice(self.freelancer.as_ref());
        dst[65..97].copy_from_slice(self.judge.as_ref());
        dst[97..105].copy_from_slice(&self.amount.to_le_bytes());
        dst[105..113].copy_from_slice(&self.deadline.to_le_bytes());
        dst[113..121].copy_from_slice(&self.deal_id.to_le_bytes());
        dst[121] = self.bump;
    }

    pub fn unpack(src: &[u8]) -> Result<Self, ProgramError> {
        if src.len() < DEAL_LEN {
            return Err(ProgramError::InvalidAccountData);
        }
        let key = |a: usize| Pubkey::try_from(&src[a..a + 32]).map_err(|_| ProgramError::InvalidAccountData);
        let u = |a: usize| -> [u8; 8] { src[a..a + 8].try_into().unwrap() };
        Ok(Deal {
            state: src[0],
            client: key(1)?,
            freelancer: key(33)?,
            judge: key(65)?,
            amount: u64::from_le_bytes(u(97)),
            deadline: i64::from_le_bytes(u(105)),
            deal_id: u64::from_le_bytes(u(113)),
            bump: src[121],
        })
    }
}

fn read_u64(data: &[u8], at: usize) -> Result<u64, ProgramError> {
    data.get(at..at + 8)
        .map(|b| u64::from_le_bytes(b.try_into().unwrap()))
        .ok_or(ProgramError::InvalidInstructionData)
}

pub fn process_instruction(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    match data.first() {
        Some(0) => create(program_id, accounts, data),
        Some(1) => release(program_id, accounts),
        Some(2) => refund(program_id, accounts),
        _ => Err(ProgramError::InvalidInstructionData),
    }
}

/// 0: client locks `amount` lamports for one milestone.
/// accounts: [client (signer, writable), deal PDA (writable), freelancer, judge, system program]
/// data: [0, deal_id u64, amount u64, deadline i64]
fn create(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let it = &mut accounts.iter();
    let client = next_account_info(it)?;
    let deal_ai = next_account_info(it)?;
    let freelancer = next_account_info(it)?;
    let judge = next_account_info(it)?;
    let sys = next_account_info(it)?;

    if !client.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if *sys.key != system_program::id() {
        return Err(ProgramError::IncorrectProgramId);
    }
    let deal_id = read_u64(data, 1)?;
    let amount = read_u64(data, 9)?;
    let deadline = read_u64(data, 17)? as i64;
    if amount == 0 {
        return Err(ProgramError::InvalidArgument);
    }

    let id_bytes = deal_id.to_le_bytes();
    let (pda, bump) = Pubkey::find_program_address(&[b"deal", client.key.as_ref(), &id_bytes], program_id);
    if pda != *deal_ai.key {
        return Err(ProgramError::InvalidSeeds);
    }

    let rent = Rent::get()?.minimum_balance(DEAL_LEN);
    let lamports = rent.checked_add(amount).ok_or(ProgramError::InvalidArgument)?;
    invoke_signed(
        &system_instruction::create_account(client.key, deal_ai.key, lamports, DEAL_LEN as u64, program_id),
        &[client.clone(), deal_ai.clone(), sys.clone()],
        &[&[b"deal", client.key.as_ref(), &id_bytes, &[bump]]],
    )?;

    let deal = Deal {
        state: STATE_FUNDED,
        client: *client.key,
        freelancer: *freelancer.key,
        judge: *judge.key,
        amount,
        deadline,
        deal_id,
        bump,
    };
    deal.pack(&mut deal_ai.try_borrow_mut_data()?);
    msg!("pause: holding {} lamports, transfer {}", amount, deal_id);
    Ok(())
}

fn load(program_id: &Pubkey, deal_ai: &AccountInfo) -> Result<Deal, ProgramError> {
    if deal_ai.owner != program_id {
        return Err(ProgramError::IncorrectProgramId);
    }
    let deal = Deal::unpack(&deal_ai.try_borrow_data()?)?;
    if deal.state != STATE_FUNDED {
        msg!("pause: transfer already settled");
        return Err(ProgramError::InvalidAccountData);
    }
    Ok(deal)
}

fn move_funds(from: &AccountInfo, to: &AccountInfo, amount: u64) -> ProgramResult {
    let new_from = from.lamports().checked_sub(amount).ok_or(ProgramError::InsufficientFunds)?;
    let new_to = to.lamports().checked_add(amount).ok_or(ProgramError::InvalidArgument)?;
    **from.try_borrow_mut_lamports()? = new_from;
    **to.try_borrow_mut_lamports()? = new_to;
    Ok(())
}

/// 1: pay the freelancer. Signed by the client or the judge.
/// accounts: [signer, deal PDA (writable), freelancer (writable)]
pub fn release(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let now = Clock::get()?.unix_timestamp;
    release_at(program_id, accounts, now)
}

pub fn release_at(program_id: &Pubkey, accounts: &[AccountInfo], now: i64) -> ProgramResult {
    let it = &mut accounts.iter();
    let signer = next_account_info(it)?;
    let deal_ai = next_account_info(it)?;
    let payee = next_account_info(it)?;

    let mut deal = load(program_id, deal_ai)?;
    if !signer.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    let by_guardian = *signer.key == deal.judge;
    let by_senior_after_hold = *signer.key == deal.client && now >= deal.deadline;
    if !by_guardian && !by_senior_after_hold {
        if *signer.key == deal.client {
            msg!("pause: hold not over (releases at {}, now {})", deal.deadline, now);
            return Err(ProgramError::Custom(2));
        }
        return Err(ProgramError::MissingRequiredSignature);
    }
    if *payee.key != deal.freelancer {
        return Err(ProgramError::InvalidArgument);
    }
    move_funds(deal_ai, payee, deal.amount)?;
    deal.state = STATE_RELEASED;
    deal.pack(&mut deal_ai.try_borrow_mut_data()?);
    msg!("pause: released {} lamports to payee", deal.amount);
    Ok(())
}

/// 2: cancel: money goes back to the senior. The senior or the guardian, any time.
/// accounts: [signer, deal PDA (writable), client (writable)]
fn refund(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let now = Clock::get()?.unix_timestamp;
    refund_at(program_id, accounts, now)
}

pub fn refund_at(program_id: &Pubkey, accounts: &[AccountInfo], now: i64) -> ProgramResult {
    let it = &mut accounts.iter();
    let signer = next_account_info(it)?;
    let deal_ai = next_account_info(it)?;
    let client = next_account_info(it)?;

    let mut deal = load(program_id, deal_ai)?;
    if !signer.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    let _ = now;
    if *signer.key != deal.judge && *signer.key != deal.client {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if *client.key != deal.client {
        return Err(ProgramError::InvalidArgument);
    }
    move_funds(deal_ai, client, deal.amount)?;
    deal.state = STATE_REFUNDED;
    deal.pack(&mut deal_ai.try_borrow_mut_data()?);
    msg!("pause: cancelled, {} lamports back to senior", deal.amount);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const AMT: u64 = 500_000_000;
    const RENT: u64 = 1_740_000;

    struct World { program: Pubkey, client: Pubkey, freelancer: Pubkey, judge: Pubkey, stranger: Pubkey, deal: Pubkey, sys: Pubkey }

    fn world() -> World {
        World { program: Pubkey::new_unique(), client: Pubkey::new_unique(), freelancer: Pubkey::new_unique(), judge: Pubkey::new_unique(), stranger: Pubkey::new_unique(), deal: Pubkey::new_unique(), sys: system_program::id() }
    }

    fn deal_bytes(w: &World, deadline: i64) -> Vec<u8> {
        let mut buf = vec![0u8; DEAL_LEN];
        Deal { state: STATE_FUNDED, client: w.client, freelancer: w.freelancer, judge: w.judge, amount: AMT, deadline, deal_id: 7, bump: 255 }.pack(&mut buf);
        buf
    }

    /// Runs one settle instruction. Returns (result, signer/payee lamports, vault lamports, state byte).
    fn run(w: &World, ix: u8, signer: Pubkey, signs: bool, payee: Pubkey, deadline: i64, now: i64) -> (ProgramResult, u64, u64, u8) {
        let (mut l_sig, mut l_deal, mut l_payee) = (10u64, RENT + AMT, 0u64);
        let mut d_sig: Vec<u8> = vec![];
        let mut d_deal = deal_bytes(w, deadline);
        let mut d_payee: Vec<u8> = vec![];
        let same = signer == payee;
        let res;
        {
            let a_sig = AccountInfo::new(&signer, signs, true, &mut l_sig, &mut d_sig, &w.sys, false, 0);
            let a_deal = AccountInfo::new(&w.deal, false, true, &mut l_deal, &mut d_deal, &w.program, false, 0);
            let a_payee = AccountInfo::new(&payee, false, true, &mut l_payee, &mut d_payee, &w.sys, false, 0);
            let accts = if same { vec![a_sig.clone(), a_deal, a_sig] } else { vec![a_sig, a_deal, a_payee] };
            res = if ix == 1 { release_at(&w.program, &accts, now) } else { refund_at(&w.program, &accts, now) };
        }
        let state = d_deal[0];
        (res, if same { l_sig } else { l_payee }, l_deal, state)
    }

    #[test]
    fn pack_roundtrip() {
        let w = world();
        let buf = deal_bytes(&w, 99);
        let d = Deal::unpack(&buf).unwrap();
        assert_eq!((d.client, d.freelancer, d.judge, d.amount, d.deadline), (w.client, w.freelancer, w.judge, AMT, 99));
    }

    #[test]
    fn guardian_can_approve_before_hold_ends() {
        let w = world();
        let (r, payee, vault, state) = run(&w, 1, w.judge, true, w.freelancer, 1000, 0);
        assert!(r.is_ok());
        assert_eq!((payee, vault, state), (AMT, RENT, STATE_RELEASED));
    }

    #[test]
    fn senior_cannot_be_rushed_before_hold_ends() {
        let w = world();
        let (r, payee, vault, state) = run(&w, 1, w.client, true, w.freelancer, 1000, 999);
        assert_eq!(r, Err(ProgramError::Custom(2)));
        assert_eq!((payee, vault, state), (0, RENT + AMT, STATE_FUNDED));
    }

    #[test]
    fn senior_can_send_after_hold_ends() {
        let w = world();
        let (r, payee, _, state) = run(&w, 1, w.client, true, w.freelancer, 1000, 1000);
        assert!(r.is_ok());
        assert_eq!((payee, state), (AMT, STATE_RELEASED));
    }

    #[test]
    fn scammer_cannot_claim_the_money() {
        let w = world();
        let (r, payee, vault, _) = run(&w, 1, w.freelancer, true, w.freelancer, 1000, 5000);
        assert_eq!(r, Err(ProgramError::MissingRequiredSignature));
        assert_eq!((payee, vault), (10, RENT + AMT));
    }

    #[test]
    fn stranger_cannot_release() {
        let w = world();
        assert_eq!(run(&w, 1, w.stranger, true, w.freelancer, 1000, 5000).0, Err(ProgramError::MissingRequiredSignature));
    }

    #[test]
    fn guardian_key_must_actually_sign() {
        let w = world();
        assert_eq!(run(&w, 1, w.judge, false, w.freelancer, 1000, 0).0, Err(ProgramError::MissingRequiredSignature));
    }

    #[test]
    fn release_cannot_be_redirected() {
        let w = world();
        let (r, _, vault, _) = run(&w, 1, w.judge, true, w.stranger, 1000, 0);
        assert_eq!(r, Err(ProgramError::InvalidArgument));
        assert_eq!(vault, RENT + AMT);
    }

    #[test]
    fn senior_can_cancel_any_time() {
        let w = world();
        let (r, payee, vault, state) = run(&w, 2, w.client, true, w.client, 1000, 0);
        assert!(r.is_ok());
        assert_eq!((payee, vault, state), (10 + AMT, RENT, STATE_REFUNDED));
    }

    #[test]
    fn guardian_can_cancel_any_time() {
        let w = world();
        let (r, payee, _, _) = run(&w, 2, w.judge, true, w.client, 1000, 0);
        assert!(r.is_ok());
        assert_eq!(payee, AMT);
    }

    #[test]
    fn cancel_cannot_be_redirected() {
        let w = world();
        assert_eq!(run(&w, 2, w.judge, true, w.stranger, 1000, 0).0, Err(ProgramError::InvalidArgument));
    }

    #[test]
    fn scammer_cannot_cancel_or_redirect() {
        let w = world();
        assert_eq!(run(&w, 2, w.freelancer, true, w.client, 1000, 5000).0, Err(ProgramError::MissingRequiredSignature));
    }

    #[test]
    fn vault_must_be_owned_by_program() {
        let w = world();
        let mut l = RENT + AMT; let mut l2 = 10u64; let mut l3 = 0u64;
        let mut d = deal_bytes(&w, 1000); let mut e: Vec<u8> = vec![]; let mut e2: Vec<u8> = vec![];
        let fake_owner = Pubkey::new_unique();
        let accts = vec![
            AccountInfo::new(&w.judge, true, true, &mut l2, &mut e, &w.sys, false, 0),
            AccountInfo::new(&w.deal, false, true, &mut l, &mut d, &fake_owner, false, 0),
            AccountInfo::new(&w.freelancer, false, true, &mut l3, &mut e2, &w.sys, false, 0),
        ];
        assert_eq!(release_at(&w.program, &accts, 0), Err(ProgramError::IncorrectProgramId));
    }

    #[test]
    fn settled_deal_cannot_pay_twice() {
        let w = world();
        let mut l = RENT + AMT; let mut l2 = 10u64; let mut l3 = 0u64;
        let mut d = deal_bytes(&w, 1000); let mut e: Vec<u8> = vec![]; let mut e2: Vec<u8> = vec![];
        let accts = vec![
            AccountInfo::new(&w.judge, true, true, &mut l2, &mut e, &w.sys, false, 0),
            AccountInfo::new(&w.deal, false, true, &mut l, &mut d, &w.program, false, 0),
            AccountInfo::new(&w.freelancer, false, true, &mut l3, &mut e2, &w.sys, false, 0),
        ];
        assert!(release_at(&w.program, &accts, 0).is_ok());
        assert_eq!(release_at(&w.program, &accts, 0), Err(ProgramError::InvalidAccountData));
        assert!(refund_at(&w.program, &accts, 0).is_err());
        assert!(release_at(&w.program, &accts, 5000).is_err());
    }
}
