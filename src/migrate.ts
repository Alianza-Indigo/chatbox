import { execSync } from 'child_process';

// Entry point del releaseCommand de Railway: corre `prisma migrate deploy`
// para aplicar migraciones pendientes antes de iniciar el servicio.
try {
  execSync('npx prisma migrate deploy', { stdio: 'inherit' });
  process.exit(0);
} catch {
  process.exit(1);
}
