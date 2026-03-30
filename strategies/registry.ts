import { Strategy } from '../core/strategy.interface';
import { whaleTrackerStrategy } from './whale-tracker/index';
import { smartMoneyStrategy }   from './smart-money/index';
import { oddsMoverStrategy }    from './odds-mover/index';
import { orderBookStrategy }    from './order-book/index';
import { resolutionArbStrategy } from './resolution-arb';

export const STRATEGIES: Strategy[] = [
  whaleTrackerStrategy,
  smartMoneyStrategy,
  oddsMoverStrategy,
  orderBookStrategy,
  resolutionArbStrategy
  // ← nuevas estrategias acá
];

export function getStrategy(id: string): Strategy | undefined {
  return STRATEGIES.find(s => s.id === id);
}