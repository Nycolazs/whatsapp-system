const crypto = require('crypto');
const Database = require('better-sqlite3');

function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

const db = new Database('./data/db/db.sqlite');

// Buscar todos os admins
const admins = db.prepare('SELECT id, username, password FROM users WHERE role = ?').all('admin');
console.log('Admins encontrados:', admins.length);

admins.forEach(admin => {
  console.log('Admin:', admin.username, '- Senha atual length:', admin.password.length);
  
  // Se a senha tiver menos de 64 caracteres, provavelmente não está hasheada
  // (SHA256 gera hash de 64 caracteres)
  if (admin.password.length < 64) {
    const hashedPassword = hashPassword(admin.password);
    console.log('  -> Atualizando senha para hash...');
    db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hashedPassword, admin.id);
    console.log('  -> Senha atualizada com sucesso!');
  } else {
    console.log('  -> Senha já está hasheada, pulando...');
  }
});

console.log('Concluído!');
db.close();
