import { describe, it, expect } from 'vitest';
import { constantTimeEqual, checkToken } from '../server/auth';

describe('constantTimeEqual', () => {
  it('is true for equal strings', () => {
    expect(constantTimeEqual('s3cr3t', 's3cr3t')).toBe(true);
    expect(constantTimeEqual('', '')).toBe(true);
  });

  it('is false for equal-length but differing strings', () => {
    expect(constantTimeEqual('s3cr3t', 's3cr3T')).toBe(false);
    expect(constantTimeEqual('abc', 'xyz')).toBe(false);
  });

  it('is false for differing-length strings', () => {
    expect(constantTimeEqual('short', 'longer-token')).toBe(false);
    expect(constantTimeEqual('', 'x')).toBe(false);
  });
});

describe('checkToken', () => {
  const expected = 'the-real-token';

  it('is false when the header is missing', () => {
    expect(checkToken(undefined, expected)).toBe(false);
    expect(checkToken(null, expected)).toBe(false);
    expect(checkToken('', expected)).toBe(false);
  });

  it('is false without the Bearer prefix', () => {
    expect(checkToken(expected, expected)).toBe(false);
    expect(checkToken(`bearer ${expected}`, expected)).toBe(false);
  });

  it('is false for a wrong token', () => {
    expect(checkToken('Bearer nope', expected)).toBe(false);
    expect(checkToken('Bearer the-real-toke', expected)).toBe(false);
  });

  it('is true for the correct Bearer token', () => {
    expect(checkToken(`Bearer ${expected}`, expected)).toBe(true);
  });

  it('is false when no secret is configured', () => {
    expect(checkToken('Bearer anything', '')).toBe(false);
  });
});
