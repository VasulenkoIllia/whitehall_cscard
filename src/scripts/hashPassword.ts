/**
 * Usage: npx ts-node src/scripts/hashPassword.ts mypassword
 * Or after build: node dist/scripts/hashPassword.js mypassword
 *
 * Outputs a bcrypt hash (12 rounds) ready to paste into AUTH_USERS_JSON
 */
import { hashPassword } from '../app/auth/password';

async function main() {
  const password = process.argv[2];
  if (!password) {
    console.error('Usage: node dist/scripts/hashPassword.js <password>');
    process.exit(1);
  }
  const hash = await hashPassword(password);
  console.log(hash);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
