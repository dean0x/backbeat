/**
 * Security Tests: Resource Exhaustion Attack Scenarios
 *
 * Tests that security bounds prevent resource exhaustion attacks including:
 * - CPU exhaustion (excessive core reservation)
 * - Memory exhaustion (unrealistic memory limits)
 * - Infinite tasks (unbounded timeouts)
 * - Output flooding (buffer overflow attacks)
 */

import { describe, expect, it } from 'vitest';
import { ConfigurationSchema } from '../../src/core/configuration';

describe('Security: Configuration Schema Attack Prevention', () => {
  describe('CPU Exhaustion Attacks', () => {
    it('should reject CPU core reservation exceeding 32 cores', () => {
      // ATTACK: Request 999 CPU cores to exhaust system resources
      const attack = { cpuCoresReserved: 999 };
      const result = ConfigurationSchema.safeParse(attack);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].path).toContain('cpuCoresReserved');
      }
    });

    it('should reject zero CPU core reservation (system instability)', () => {
      // ATTACK: Reserve zero cores, allowing complete CPU exhaustion
      const attack = { cpuCoresReserved: 0 };
      const result = ConfigurationSchema.safeParse(attack);

      expect(result.success).toBe(false);
    });

    it('should accept maximum safe CPU core reservation', () => {
      // BOUNDARY: Maximum allowed value should work
      const maxSafe = { cpuCoresReserved: 32 };
      const result = ConfigurationSchema.safeParse(maxSafe);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.cpuCoresReserved).toBe(32);
      }
    });
  });

  describe('Memory Exhaustion Attacks', () => {
    it('should reject memory reservation exceeding 64GB', () => {
      // ATTACK: Request 999 TB of memory reserve
      const attack = { memoryReserve: 999 * 1024 * 1024 * 1024 * 1024 };
      const result = ConfigurationSchema.safeParse(attack);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].path).toContain('memoryReserve');
      }
    });

    it('should accept maximum safe memory reservation', () => {
      // BOUNDARY: 64GB maximum should work
      const maxSafe = { memoryReserve: 64 * 1024 * 1024 * 1024 };
      const result = ConfigurationSchema.safeParse(maxSafe);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.memoryReserve).toBe(64 * 1024 * 1024 * 1024);
      }
    });

    it('should accept zero memory reservation (minimal protection)', () => {
      // EDGE CASE: Zero is allowed (no reserve, risky but valid)
      const minimal = { memoryReserve: 0 };
      const result = ConfigurationSchema.safeParse(minimal);

      expect(result.success).toBe(true);
    });
  });

  describe('Infinite Task Attacks', () => {
    it('should reject task timeout exceeding 24 hours (hard maximum)', () => {
      // ATTACK: Timeout beyond max (86400001ms) to lock workers indefinitely.
      // Schema allows 0–86400000ms; 0 means disabled (DECISION: tasks run 2.5+ hours).
      const attack = { timeout: 24 * 60 * 60 * 1000 + 1 }; // 1ms over 24hr max
      const result = ConfigurationSchema.safeParse(attack);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].path).toContain('timeout');
      }
    });

    it('should reject negative timeout', () => {
      // ATTACK: Negative timeout is invalid (min is 0 = disabled)
      const attack = { timeout: -1 };
      const result = ConfigurationSchema.safeParse(attack);

      expect(result.success).toBe(false);
    });

    it('should accept maximum safe timeout of 24 hours', () => {
      // BOUNDARY: 24 hour maximum (86400000ms) should work
      const maxSafe = { timeout: 24 * 60 * 60 * 1000 };
      const result = ConfigurationSchema.safeParse(maxSafe);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.timeout).toBe(24 * 60 * 60 * 1000);
      }
    });
  });

  describe('Output Buffer Overflow Attacks', () => {
    it('should reject output buffer exceeding 1GB', () => {
      // ATTACK: 10GB output buffer to exhaust memory
      const attack = { maxOutputBuffer: 10 * 1024 * 1024 * 1024 };
      const result = ConfigurationSchema.safeParse(attack);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].path).toContain('maxOutputBuffer');
      }
    });

    it('should reject output buffer below minimum threshold', () => {
      // ATTACK: Tiny buffer causing excessive truncation/errors
      const attack = { maxOutputBuffer: 512 };
      const result = ConfigurationSchema.safeParse(attack);

      expect(result.success).toBe(false);
    });

    it('should accept maximum safe output buffer of 1GB', () => {
      // BOUNDARY: 1GB maximum should work
      const maxSafe = { maxOutputBuffer: 1024 * 1024 * 1024 };
      const result = ConfigurationSchema.safeParse(maxSafe);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.maxOutputBuffer).toBe(1024 * 1024 * 1024);
      }
    });
  });

  describe('Combined Multi-Vector Attacks', () => {
    it('should reject configuration with multiple attack vectors', () => {
      // ATTACK: Combined resource exhaustion attempt
      const multiAttack = {
        cpuCoresReserved: 999,
        memoryReserve: 999 * 1024 * 1024 * 1024 * 1024,
        timeout: 999 * 60 * 60 * 1000,
        maxOutputBuffer: 999 * 1024 * 1024 * 1024,
      };
      const result = ConfigurationSchema.safeParse(multiAttack);

      expect(result.success).toBe(false);
      if (!result.success) {
        // Should have multiple validation errors
        expect(result.error.issues.length).toBeGreaterThan(1);
      }
    });

    it('should accept configuration at all maximum safe boundaries', () => {
      // BOUNDARY: All max values together should work
      const maxSafeConfig = {
        cpuCoresReserved: 32,
        memoryReserve: 64 * 1024 * 1024 * 1024,
        timeout: 60 * 60 * 1000,
        maxOutputBuffer: 1024 * 1024 * 1024,
      };
      const result = ConfigurationSchema.safeParse(maxSafeConfig);

      expect(result.success).toBe(true);
    });
  });

  describe('Default Security Guarantees', () => {
    it('should provide safe defaults when no config specified', () => {
      // Empty config should get all defaults
      const result = ConfigurationSchema.safeParse({});

      expect(result.success).toBe(true);
      if (result.success) {
        const config = result.data;

        // Verify all defaults are within security bounds
        expect(config.cpuCoresReserved).toBeGreaterThanOrEqual(1);
        expect(config.cpuCoresReserved).toBeLessThanOrEqual(32);

        expect(config.memoryReserve).toBeGreaterThanOrEqual(0);
        expect(config.memoryReserve).toBeLessThanOrEqual(64 * 1024 * 1024 * 1024);

        expect(config.timeout).toBeGreaterThanOrEqual(0); // 0 = disabled (default)
        expect(config.timeout).toBeLessThanOrEqual(24 * 60 * 60 * 1000); // max 24hr

        expect(config.maxOutputBuffer).toBeGreaterThanOrEqual(1024);
        expect(config.maxOutputBuffer).toBeLessThanOrEqual(1024 * 1024 * 1024);
      }
    });

    it('should fall back to secure defaults on invalid configuration', () => {
      // When parsing fails, loadConfiguration() uses schema defaults
      const invalidConfig = {
        timeout: -1,
        cpuCoresReserved: -999,
        memoryReserve: -1,
      };
      const result = ConfigurationSchema.safeParse(invalidConfig);

      // Should fail validation
      expect(result.success).toBe(false);

      // loadConfiguration() would return safe defaults via parse({})
      const fallback = ConfigurationSchema.parse({});
      expect(fallback.timeout).toBe(0); // Disabled by default (tasks run 2.5+ hours)
      expect(fallback.cpuCoresReserved).toBe(2);
      expect(fallback.memoryReserve).toBe(2684354560); // 2.5GB
    });
  });

  describe('EventBus Security Limits', () => {
    it('should reject excessive event listeners (memory leak attack)', () => {
      // ATTACK: Create 1M listeners to exhaust memory
      const attack = { maxListenersPerEvent: 1000000 };
      const result = ConfigurationSchema.safeParse(attack);

      expect(result.success).toBe(false);
    });

    it('should reject excessive total subscriptions', () => {
      // ATTACK: Create 10M subscriptions to exhaust memory
      const attack = { maxTotalSubscriptions: 10000000 };
      const result = ConfigurationSchema.safeParse(attack);

      expect(result.success).toBe(false);
    });

    it('should accept maximum safe event system limits', () => {
      const maxSafe = {
        maxListenersPerEvent: 10000,
        maxTotalSubscriptions: 100000,
      };
      const result = ConfigurationSchema.safeParse(maxSafe);

      expect(result.success).toBe(true);
    });
  });

  describe('Process Management Security', () => {
    it('should reject excessive kill grace period (resource lock)', () => {
      // ATTACK: 10 minute grace period locks resources
      const attack = { killGracePeriodMs: 10 * 60 * 1000 };
      const result = ConfigurationSchema.safeParse(attack);

      expect(result.success).toBe(false);
    });

    it('should reject sub-second kill grace period', () => {
      // ATTACK: Instant kill prevents cleanup
      const attack = { killGracePeriodMs: 500 };
      const result = ConfigurationSchema.safeParse(attack);

      expect(result.success).toBe(false);
    });

    it('should accept maximum safe process timeouts', () => {
      const maxSafe = {
        killGracePeriodMs: 60000, // 60 seconds
        resourceMonitorIntervalMs: 60000,
        minSpawnDelayMs: 10000,
      };
      const result = ConfigurationSchema.safeParse(maxSafe);

      expect(result.success).toBe(true);
    });
  });
});
