import { encodeReferralParams, verifyReferralChecksum, generateChecksum } from '../../features/referral-sharing/utils/referralUrl';

describe('Referral URL encoding and checksum generation', () => {
  it('should encode parameters and include a checksum', () => {
    const params = { agent: '123', campaign: 'spring' };
    const encoded = encodeReferralParams(params);
    
    expect(encoded).toContain('agent=123');
    expect(encoded).toContain('campaign=spring');
    expect(encoded).toContain('chk=');
  });

  it('should verify a valid checksum successfully', () => {
    const params = { agent: '123', campaign: 'spring' };
    const encoded = encodeReferralParams(params);
    
    const isValid = verifyReferralChecksum(encoded);
    expect(isValid).toBe(true);
  });

  it('should reject a tampered checksum', () => {
    const params = { agent: '123', campaign: 'spring' };
    const encoded = encodeReferralParams(params);
    
    // Tamper with the parameter
    const tampered = encoded.replace('agent=123', 'agent=999');
    
    const isValid = verifyReferralChecksum(tampered);
    expect(isValid).toBe(false);
  });

  it('should reject missing checksum', () => {
    const isValid = verifyReferralChecksum('agent=123&campaign=spring');
    expect(isValid).toBe(false);
  });
});
