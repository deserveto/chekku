import { describe, expect, it } from 'vitest';
import { evaluateArithmetic } from './calculator.js';

describe('evaluateArithmetic', () => {
  it('honors precedence and parentheses', () => {
    expect(evaluateArithmetic('17 * 23')).toBe(391);
    expect(evaluateArithmetic('2 + 3 * 4')).toBe(14);
    expect(evaluateArithmetic('(2 + 3) * 4')).toBe(20);
  });

  it('supports unary operators and right-associative powers', () => {
    expect(evaluateArithmetic('-2 + 5')).toBe(3);
    expect(evaluateArithmetic('2 ^ 3 ^ 2')).toBe(512);
  });

  it('rejects code and division by zero', () => {
    expect(() => evaluateArithmetic('process.exit()')).toThrow('Expected a number');
    expect(() => evaluateArithmetic('1 / 0')).toThrow('Division by zero');
  });
});
