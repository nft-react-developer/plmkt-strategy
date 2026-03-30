/**
 * Contrato que toda estrategia debe implementar.
 * Para agregar una nueva estrategia:
 *   1. Crear carpeta en strategies/<nombre>/
 *   2. Exportar un objeto que implemente Strategy
 *   3. Importarlo en strategies/registry.ts
 *
 * Nada más. El runner la levanta automáticamente.
 */

export type SignalSeverity = 'low' | 'medium' | 'high';

export interface Signal {
  strategyId: string;
  severity:   SignalSeverity;
  title:      string;
  body:       string;
  metadata:   Record<string, unknown>;
}

export interface StrategyRunResult {
  signals: Signal[];
  /** métricas opcionales que se persisten en strategy_run_log */
  metrics?: Record<string, number>;
}

export interface Strategy {
  /** Identificador único snake_case, eg. 'whale_tracker' */
  id: string;

  /** Nombre legible para UI / Telegram */
  name: string;

  /** Descripción corta */
  description: string;

  /**
   * Parámetros por defecto. Se mezclan con lo que esté en DB
   * (la fila strategy_config.params tiene prioridad).
   */
  defaultParams: Record<string, unknown>;

  /**
   * Lógica principal. Se llama cada `intervalSeconds` definido en params.
   * Recibe los params ya mergeados (defaultParams ← DB).
   */
  run(params: Record<string, unknown>): Promise<StrategyRunResult>;

  /**
   * Opcional. Se llama una vez al iniciar el runner.
   * Útil para crear índices, warmup de cache, etc.
   */
  init?(params: Record<string, unknown>): Promise<void>;

  /**
   * Opcional. Se llama al apagar el runner limpiamente.
   */
  teardown?(): Promise<void>;
}