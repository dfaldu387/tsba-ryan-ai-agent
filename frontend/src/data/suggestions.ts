import type { Audience, Channel } from '@tsba/shared';

// The 9 sample questions from the reference page's "Try one of these" list.
// `channel` is the channel the question arrived on — selecting a sample auto-
// selects "Arrived from", and the approved reply goes back out the same way.
export const SUGGESTIONS: Array<{ audience: Audience; channel: Channel; question: string }> = [
  { audience: 'installer', channel: 'chat', question: "What's the minimum spacing between a battery stack and a window?" },
  { audience: 'customer', channel: 'email', question: "What's the minimum spacing between a battery stack and a window?" },
  { audience: 'installer', channel: 'chat', question: "We're adding a Deye hybrid to a house with existing solar. How do we set up the meters?" },
  { audience: 'installer', channel: 'email', question: 'Adding an SAJ H2 hybrid next to an existing grid-tied inverter. What meter setup do we need?' },
  { audience: 'sales', channel: 'chat', question: 'Can I tell a customer the Deye AI-W5.1 battery is 100% usable?' },
  { audience: 'installer', channel: 'chat', question: 'Can I put a heat pump right next to the battery?' },
  { audience: 'installer', channel: 'text', question: "Client's inverter cut out at 3:58 pm today and won't come back on. Can you check why?" },
  { audience: 'customer', channel: 'email', question: 'How much does a 10 kWh battery cost installed?' },
  { audience: 'customer', channel: 'text', question: 'Can I move my battery into the garage myself?' },
];
