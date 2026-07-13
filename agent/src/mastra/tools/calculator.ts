import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

class ArithmeticParser {
  private index = 0;

  constructor(private readonly source: string) {}

  parse(): number {
    const result = this.parseExpression();
    this.skipWhitespace();
    if (this.index !== this.source.length) {
      throw new Error(`Unexpected token at position ${this.index + 1}`);
    }
    if (!Number.isFinite(result)) {
      throw new Error('Expression produced a non-finite result');
    }
    return result;
  }

  private parseExpression(): number {
    let value = this.parseTerm();
    while (true) {
      this.skipWhitespace();
      if (this.consume('+')) value += this.parseTerm();
      else if (this.consume('-')) value -= this.parseTerm();
      else return value;
    }
  }

  private parseTerm(): number {
    let value = this.parsePower();
    while (true) {
      this.skipWhitespace();
      if (this.consume('*')) value *= this.parsePower();
      else if (this.consume('/')) {
        const divisor = this.parsePower();
        if (divisor === 0) throw new Error('Division by zero');
        value /= divisor;
      } else if (this.consume('%')) {
        const divisor = this.parsePower();
        if (divisor === 0) throw new Error('Division by zero');
        value %= divisor;
      } else return value;
    }
  }

  private parsePower(): number {
    const base = this.parseUnary();
    this.skipWhitespace();
    if (!this.consume('^')) return base;
    return base ** this.parsePower();
  }

  private parseUnary(): number {
    this.skipWhitespace();
    if (this.consume('+')) return this.parseUnary();
    if (this.consume('-')) return -this.parseUnary();
    return this.parsePrimary();
  }

  private parsePrimary(): number {
    this.skipWhitespace();
    if (this.consume('(')) {
      const value = this.parseExpression();
      this.skipWhitespace();
      if (!this.consume(')')) throw new Error(`Expected ')' at position ${this.index + 1}`);
      return value;
    }
    return this.parseNumber();
  }

  private parseNumber(): number {
    this.skipWhitespace();
    const remaining = this.source.slice(this.index);
    const match = remaining.match(/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/);
    if (!match) throw new Error(`Expected a number at position ${this.index + 1}`);
    this.index += match[0].length;
    return Number(match[0]);
  }

  private consume(token: string): boolean {
    if (this.source.startsWith(token, this.index)) {
      this.index += token.length;
      return true;
    }
    return false;
  }

  private skipWhitespace(): void {
    while (/\s/.test(this.source[this.index] ?? '')) this.index += 1;
  }
}

export function evaluateArithmetic(expression: string): number {
  const trimmed = expression.trim();
  if (!trimmed) throw new Error('Expression is required');
  if (trimmed.length > 500) throw new Error('Expression is too long');
  return new ArithmeticParser(trimmed).parse();
}

export const calculatorTool = createTool({
  id: 'calculator',
  description:
    'Evaluate a numeric arithmetic expression. Use this for exact calculations instead of doing arithmetic mentally. Supports parentheses, +, -, *, /, %, and ^.',
  inputSchema: z.object({
    expression: z.string().min(1).max(500).describe('Arithmetic expression, for example: (17 * 23) + 4'),
  }),
  outputSchema: z.object({
    expression: z.string(),
    result: z.number(),
  }),
  execute: async ({ expression }) => ({
    expression,
    result: evaluateArithmetic(expression),
  }),
});
