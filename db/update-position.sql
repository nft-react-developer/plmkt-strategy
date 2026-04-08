UPDATE positions
SET status = 'closed', close_reason = 'manual', closed_at = NOW()
WHERE paper_trading = 0 AND status = 'open';