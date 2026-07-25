// Unit tests for the pure emergency-helicopter classifier. classifyEmergency has
// no DOM dependency, but aircraft.ts imports maplibre-gl (a value import) at the
// top, so we stub that module to keep the test in the fast node environment.
import { describe, expect, test, vi } from 'vitest';

vi.mock('maplibre-gl', () => ({ Popup: class {} }));

const { classifyEmergency } = await import('./aircraft');

describe('classifyEmergency', () => {
  test('classifies a known NPAS / police registration as police', () => {
    expect(classifyEmergency({ hex: 'x', r: 'G-POLD', t: 'EC35' })).toBe('police');
    expect(classifyEmergency({ hex: 'x', r: 'G-MPSA', t: 'EC45' })).toBe('police');
    expect(classifyEmergency({ hex: 'x', r: 'G-NPAS', t: 'EC35' })).toBe('police');
  });

  test('classifies a known air-ambulance registration as air-ambulance', () => {
    expect(classifyEmergency({ hex: 'x', r: 'G-LAAA', t: 'EC35' })).toBe('air-ambulance');
    expect(classifyEmergency({ hex: 'x', r: 'G-LNAC', t: 'A169' })).toBe('air-ambulance');
    expect(classifyEmergency({ hex: 'x', r: 'G-KSSC', t: 'A169' })).toBe('air-ambulance');
  });

  test('reg prefixes future-proof new deliveries', () => {
    expect(classifyEmergency({ hex: 'x', r: 'G-POLZ' })).toBe('police'); // any G-POL* is police
    expect(classifyEmergency({ hex: 'x', r: 'G-LAAZ' })).toBe('air-ambulance'); // any G-LAA* is LAA
  });

  test('falls back to callsign prefixes when reg is unknown', () => {
    // Space-padded callsigns as they arrive from ADS-B.
    expect(classifyEmergency({ hex: 'x', flight: 'NPAS51  ' })).toBe('police');
    expect(classifyEmergency({ hex: 'x', flight: 'HLE21   ' })).toBe('air-ambulance');
    expect(classifyEmergency({ hex: 'x', flight: 'HEMS20  ' })).toBe('air-ambulance');
  });

  test('registration wins over callsign (priority order)', () => {
    // Police reg but an air-ambulance-looking callsign → reg is authoritative.
    expect(classifyEmergency({ hex: 'x', r: 'G-MPSA', flight: 'HEMS99' })).toBe('police');
  });

  test('leaves ordinary aircraft and helicopters unclassified (null)', () => {
    expect(classifyEmergency({ hex: 'x', r: 'G-IIDD', flight: 'GIIDD', t: 'RV8' })).toBeNull();
    expect(classifyEmergency({ hex: 'x', r: 'G-JAYK', flight: 'GJAYK', t: 'R44' })).toBeNull();
    expect(classifyEmergency({ hex: 'x', flight: 'BAW123' })).toBeNull();
    expect(classifyEmergency({ hex: 'x' })).toBeNull();
  });
});
