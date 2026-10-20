import type { Audience } from '@tsba/shared';

// The 9 sample questions from the reference page's "Try one of these" list.
export const SUGGESTIONS: Array<{ audience: Audience; question: string }> = [
  { audience: 'installer', question: "What's the minimum spacing between a battery stack and a window?" },
  { audience: 'customer', question: "What's the minimum spacing between a battery stack and a window?" },
  { audience: 'installer', question: "We're adding a Deye hybrid to a house with existing solar. How do we set up the meters?" },
  { audience: 'installer', question: 'Adding an SAJ H2 hybrid next to an existing grid-tied inverter. What meter setup do we need?' },
  { audience: 'sales', question: 'Can I tell a customer the Deye AI-W5.1 battery is 100% usable?' },
  { audience: 'installer', question: 'Can I put a heat pump right next to the battery?' },
  { audience: 'installer', question: "Client's inverter cut out at 3:58 pm today and won't come back on. Can you check why?" },
  { audience: 'customer', question: 'How much does a 10 kWh battery cost installed?' },
  { audience: 'customer', question: 'Can I move my battery into the garage myself?' },
];
