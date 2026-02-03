'use strict';

const { z } = require('zod');

// Schema para login
const loginSchema = z.object({
  username: z.string().min(1, 'Usuário é obrigatório').max(100),
  password: z.string().min(1, 'Senha é obrigatória').max(200),
});

// Schema para criação de admin
const setupAdminSchema = z.object({
  username: z.string().min(3, 'Usuário deve ter no mínimo 3 caracteres').max(100),
  password: z.string().min(6, 'Senha deve ter no mínimo 6 caracteres').max(200),
});

// Schema para criação/edição de vendedor
const sellerSchema = z.object({
  name: z.string().min(1, 'Nome é obrigatório').max(100),
  password: z.string().min(6, 'Senha deve ter no mínimo 6 caracteres').max(200).optional(),
  active: z.boolean().optional(),
});

// Schema para envio de mensagem
const sendMessageSchema = z.object({
  message: z.string().min(1, 'Mensagem é obrigatória').max(10000),
  reply_to_id: z.number().int().positive().optional(),
});

// Schema para atualização de status de ticket
const ticketStatusSchema = z.object({
  status: z.enum(['pendente', 'aguardando', 'em_atendimento', 'resolvido', 'encerrado']),
});

// Schema para atribuição de ticket
const assignTicketSchema = z.object({
  sellerId: z.number().int().nonnegative(),
});

// Schema para blacklist
const blacklistSchema = z.object({
  phone: z.string().regex(/^[0-9]{10,15}(@s\.whatsapp\.net)?$/, 'Telefone inválido'),
  reason: z.string().max(500).optional(),
});

// Schema para horários de funcionamento
const businessHoursSchema = z.array(
  z.object({
    day: z.number().int().min(0).max(6),
    open_time: z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/).nullable(),
    close_time: z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/).nullable(),
    enabled: z.boolean(),
  })
);

// Schema para exceção de horário
const businessExceptionSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  closed: z.boolean(),
  open_time: z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/).nullable().optional(),
  close_time: z.string().regex(/^([01]\d|2[0-3]):([0-5]\d)$/).nullable().optional(),
  reason: z.string().max(500).nullable().optional(),
});

// Middleware de validação
function validate(schema) {
  return (req, res, next) => {
    try {
      const parsed = schema.parse(req.body);
      req.body = parsed; // Sanitiza: remove campos extras
      return next();
    } catch (error) {
      if (error instanceof z.ZodError) {
        // ZodError tem a propriedade issues ao invés de errors
        const messages = error.issues && Array.isArray(error.issues) 
          ? error.issues.map((e) => `${e.path.join('.')}: ${e.message}`)
          : error.errors && Array.isArray(error.errors)
          ? error.errors.map((e) => `${e.path.join('.')}: ${e.message}`)
          : ['Erro desconhecido na validação'];
        
        console.error('[validation] Erro de validação:', messages);
        return res.status(400).json({ error: 'Validação falhou', details: messages });
      }
      
      console.error('[validation] Erro ao validar:', error.message);
      return res.status(400).json({ error: 'Dados inválidos: ' + error.message });
    }
  };
}

module.exports = {
  validate,
  schemas: {
    login: loginSchema,
    setupAdmin: setupAdminSchema,
    seller: sellerSchema,
    sendMessage: sendMessageSchema,
    ticketStatus: ticketStatusSchema,
    assignTicket: assignTicketSchema,
    blacklist: blacklistSchema,
    businessHours: businessHoursSchema,
    businessException: businessExceptionSchema,
  },
};
