import { Prisma } from '@prisma/client';
import { db } from '../db';

export interface AuditEntry {
  orgId?: string;
  actorId?: string;
  actorRole?: string;
  action: string;
  targetType: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
  ip?: string;
}

// Fire-and-forget — audit failures must never block or fail the request
export function logAudit(entry: AuditEntry): void {
  const data: Prisma.AuditLogCreateInput = {
    ...entry,
    metadata: entry.metadata ? (entry.metadata as Prisma.InputJsonValue) : undefined,
  };
  db.auditLog.create({ data }).catch(() => { /* silent */ });
}
