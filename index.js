// index.js
import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionsBitField,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  AttachmentBuilder
} from 'discord.js';
import ollama from 'ollama';
import dotenv from 'dotenv';
import axios from 'axios';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import si from 'systeminformation';

dotenv.config();

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.CLIENT_ID;

// __dirname 설정 (ES 모듈)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ------------------------------------------------------------------
// EULA 텍스트 (개인정보처리방침 및 주의사항)
// ------------------------------------------------------------------
const EULA_TEXT = `
[개인정보처리방침 및 주의사항]

본 봇은 AI 기술을 활용하여 응답을 생성합니다. AI는 때때로 실수를 할 수 있으며, 특히 어린 이용자는 반드시 보호자의 확인이 필요합니다.
사용자는 본 봇을 사용함으로써, 본 개인정보처리방침 및 주의사항에 동의하는 것으로 간주됩니다.
저희는 사용자의 Discord ID와 사용자가 제공한 이름 정보를 서비스 제공 목적으로만 저장하며, 이는 최소한의 정보입니다.
모든 AI 응답은 참고용이며, 정보의 정확성을 보장하지 않습니다.
특히 어린 이용자는 AI의 응답을 신뢰하기 전에 반드시 성인 보호자의 확인을 받으시기 바랍니다.
`;

// ------------------------------------------------------------------
// Database 초기화: 대화 기록 및 EULA 동의 정보 저장
// ------------------------------------------------------------------
const db = new Database('bot.db');
db.exec(`
CREATE TABLE IF NOT EXISTS conversations (
  guild_id TEXT,
  channel_id TEXT,
  conversation TEXT,
  PRIMARY KEY(guild_id, channel_id)
);

CREATE TABLE IF NOT EXISTS eula_agreements (
  user_id TEXT PRIMARY KEY,
  username TEXT,
  agreed_at INTEGER
)
`);

const getConversationStmt = db.prepare("SELECT conversation FROM conversations WHERE guild_id = ? AND channel_id = ?");
const upsertConversationStmt = db.prepare("INSERT OR REPLACE INTO conversations (guild_id, channel_id, conversation) VALUES (?, ?, ?)");
const clearConversationStmt = db.prepare("DELETE FROM conversations WHERE guild_id = ? AND channel_id = ?");

function updateConversation(guildId, channelId, conversation) {
  upsertConversationStmt.run(guildId, channelId, JSON.stringify(conversation));
}

const checkEulaStmt = db.prepare("SELECT * FROM eula_agreements WHERE user_id = ?");
const insertEulaStmt = db.prepare("INSERT INTO eula_agreements (user_id, username, agreed_at) VALUES (?, ?, ?)");

function hasUserAgreedEula(userId) {
  return checkEulaStmt.get(userId);
}

function storeUserEula(userId, username) {
  insertEulaStmt.run(userId, username, Date.now());
}

// ------------------------------------------------------------------
// 서버별 기본 모델 관리 (대화 기억은 채널별로 저장)
const guildDefaultModels = {}; // { [guildId]: modelName }

// ------------------------------------------------------------------
// 슬래시 커맨드 정의: /chat, /listmodels, /setmodel, /clearmemory, /eula, /export, /performance, /performance_detail
const commands = [
  new SlashCommandBuilder()
    .setName('chat')
    .setDescription('로컬 LLM(Ollama)와 대화합니다 (채널별 대화 기억 및 발화자 정보 포함).')
    .addStringOption(option =>
      option.setName('prompt')
            .setDescription('LLM에게 보낼 메시지')
            .setRequired(true)
    )
    .addStringOption(option =>
      option.setName('model')
            .setDescription('사용할 모델의 이름 (미지정 시 기본 모델 사용)')
            .setRequired(false)
    )
    .addAttachmentOption(option =>
      option.setName('file')
            .setDescription('첨부 파일 (선택 사항, 최대 1GB)')
            .setRequired(false)
    ),
  new SlashCommandBuilder()
    .setName('listmodels')
    .setDescription('로컬 Ollama 서버에 설치된 모델 목록을 확인합니다.'),
  new SlashCommandBuilder()
    .setName('setmodel')
    .setDescription('현재 서버의 기본 모델을 설정합니다. (관리자 전용)')
    .addStringOption(option =>
      option.setName('model')
            .setDescription('설정할 모델의 이름 (예: mistral, llama3.1 등)')
            .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('clearmemory')
    .setDescription('현재 채널의 대화 기억을 삭제합니다. (관리자 전용)'),
  new SlashCommandBuilder()
    .setName('eula')
    .setDescription('개인정보처리방침 및 주의사항을 확인하고 동의합니다.'),
  new SlashCommandBuilder()
    .setName('export')
    .setDescription('현재 채널의 대화 기록을 JSON 파일로 내보냅니다. (동의한 사용자만 사용 가능)'),
  new SlashCommandBuilder()
    .setName('performance')
    .setDescription('현재 CPU, GPU, 메모리 사용량(%)을 표시합니다.'),
  new SlashCommandBuilder()
    .setName('performance_detail')
    .setDescription('자세한 CPU, GPU, 메모리 사용량 정보를 표시합니다.')
].map(command => command.toJSON());

// ------------------------------------------------------------------
// 슬래시 커맨드 등록
const rest = new REST({ version: '10' }).setToken(token);
(async () => {
  try {
    console.log('슬래시 커맨드 등록 중...');
    await rest.put(Routes.applicationCommands(clientId), { body: commands });
    console.log('슬래시 커맨드 등록 완료.');
  } catch (error) {
    console.error('슬래시 커맨드 등록 오류:', error);
  }
})();

// ------------------------------------------------------------------
// Discord 클라이언트 생성
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('ready', () => {
  console.log(`로그인 완료: ${client.user.tag}`);
});

// ------------------------------------------------------------------
// 인터랙션 이벤트 처리
client.on('interactionCreate', async interaction => {
  // 슬래시 커맨드 처리
  if (interaction.isChatInputCommand()) {
    const { commandName, guildId, channelId, member } = interaction;

    if (commandName === 'eula') {
      const eulaEmbed = {
        title: "개인정보처리방침 및 주의사항",
        description: EULA_TEXT,
        color: 0x0099ff
      };
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('eula_agree')
          .setLabel('동의합니다')
          .setStyle(ButtonStyle.Primary)
      );
      await interaction.reply({ embeds: [eulaEmbed], components: [row], ephemeral: true });
    }
    else if (commandName === 'chat') {
      if (!hasUserAgreedEula(interaction.user.id)) {
        return interaction.reply({ content: "먼저 /eula 명령어를 사용하여 개인정보처리방침에 동의해 주세요.", ephemeral: true });
      }
      const prompt = interaction.options.getString('prompt');
      let model = interaction.options.getString('model');
      const attachment = interaction.options.getAttachment('file');
      
      if (!model) {
        if (guildDefaultModels[guildId]) {
          model = guildDefaultModels[guildId];
        } else {
          return interaction.reply({ content: "기본 모델이 설정되어 있지 않습니다. `/setmodel` 명령어로 기본 모델을 설정해주세요.", ephemeral: true });
        }
      }
      
      let conversation = [];
      const convRow = getConversationStmt.get(guildId, channelId);
      if (convRow && convRow.conversation) {
        try {
          conversation = JSON.parse(convRow.conversation);
        } catch (e) {
          conversation = [];
        }
      }
      
      conversation.push({
        role: 'user',
        content: prompt,
        timestamp: Date.now(),
        sender: { id: interaction.user.id, username: interaction.user.username }
      });
      
      if (attachment) {
        if (attachment.size > 1073741824) {
          return interaction.reply({ content: "첨부 파일 크기가 1GB를 초과합니다.", ephemeral: true });
        }
        try {
          const contentType = attachment.contentType || "";
          let fileContent;
          let filePayload = {
            role: 'user',
            content: `파일 첨부: ${attachment.name}`,
            sender: { id: interaction.user.id, username: interaction.user.username }
          };
          if (contentType.startsWith("text/")) {
            const res = await axios.get(attachment.url, { responseType: 'text' });
            fileContent = res.data;
            filePayload.content += `\n파일 내용:\n${fileContent}`;
          } else if (contentType.startsWith("image/")) {
            const res = await axios.get(attachment.url, { responseType: 'arraybuffer' });
            fileContent = Buffer.from(res.data, 'binary').toString('base64');
            filePayload.images = [fileContent];
          } else {
            const res = await axios.get(attachment.url, { responseType: 'arraybuffer' });
            fileContent = Buffer.from(res.data, 'binary').toString('base64');
            filePayload.images = [fileContent];
          }
          conversation.push(filePayload);
        } catch (error) {
          console.error('파일 첨부 처리 오류:', error);
          return interaction.reply({ content: "첨부 파일 처리 중 오류가 발생했습니다.", ephemeral: true });
        }
      }
      
      await interaction.deferReply();
      await interaction.editReply("AI는 느리니 잠시만 기다려주세요...");
      try {
        const response = await ollama.chat({
          model,
          messages: conversation
        });
        const reply = response.message.content;
        conversation.push({
          role: 'assistant',
          content: reply,
          timestamp: Date.now(),
          sender: { id: "assistant", username: "AI" }
        });
        updateConversation(guildId, channelId, conversation);
        await interaction.editReply(reply);
      } catch (error) {
        console.error('Ollama API 호출 오류:', error);
        await interaction.editReply('LLM과 통신하는 도중 오류가 발생했습니다.');
      }
    }
    else if (commandName === 'listmodels') {
      try {
        const listResponse = await ollama.list();
        let modelsText = "사용 가능한 모델 목록:\n";
        if (listResponse && listResponse.models && listResponse.models.length > 0) {
          listResponse.models.forEach(m => {
            modelsText += `- ${m.name}\n`;
          });
        } else {
          modelsText += "등록된 모델이 없습니다.";
        }
        await interaction.reply({ content: modelsText, ephemeral: true });
      } catch (error) {
        console.error('모델 목록 조회 오류:', error);
        await interaction.reply({ content: "모델 목록을 가져오는 중 오류가 발생했습니다.", ephemeral: true });
      }
    }
    else if (commandName === 'setmodel') {
      if (!member.permissions.has(PermissionsBitField.Flags.Administrator)) {
        return interaction.reply({ content: "이 명령어는 관리자만 사용할 수 있습니다.", ephemeral: true });
      }
      const modelName = interaction.options.getString('model');
      guildDefaultModels[guildId] = modelName;
      await interaction.reply(`현재 서버의 기본 모델이 **${modelName}**(으)로 설정되었습니다.`);
    }
    else if (commandName === 'clearmemory') {
      if (!member.permissions.has(PermissionsBitField.Flags.Administrator)) {
        return interaction.reply({ content: "이 명령어는 관리자만 사용할 수 있습니다.", ephemeral: true });
      }
      clearConversationStmt.run(guildId, channelId);
      await interaction.reply("현재 채널의 대화 기억이 삭제되었습니다.");
    }
    else if (commandName === 'export') {
      if (!hasUserAgreedEula(interaction.user.id)) {
        return interaction.reply({ content: "먼저 /eula 명령어로 개인정보처리방침에 동의해 주세요.", ephemeral: true });
      }
      const convRow = getConversationStmt.get(guildId, channelId);
      if (!convRow || !convRow.conversation) {
        return interaction.reply({ content: "현재 채널에 대화 기록이 없습니다.", ephemeral: true });
      }
      try {
        const jsonContent = convRow.conversation;
        const buffer = Buffer.from(jsonContent, 'utf-8');
        const attachment = new AttachmentBuilder(buffer, { name: "conversation.json" });
        await interaction.reply({ content: "대화 기록을 JSON 파일로 내보냅니다.", files: [attachment], ephemeral: true });
      } catch (error) {
        console.error('대화 기록 내보내기 오류:', error);
        await interaction.reply({ content: "대화 기록 내보내는 중 오류가 발생했습니다.", ephemeral: true });
      }
    }
    else if (commandName === 'performance') {
      try {
        const load = await si.currentLoad();
        const cpuUsage = load.currentLoad.toFixed(2);
        const memData = await si.mem();
        const memUsagePercent = ((memData.used / memData.total) * 100).toFixed(2);
        const graphics = await si.graphics();
        let gpuUsage = '정보 없음';
        if (graphics.controllers && graphics.controllers.length > 0) {
          const gpu = graphics.controllers[0];
          gpuUsage = (gpu.utilizationGpu != null) ? gpu.utilizationGpu + '%' : '정보 없음';
        }
        const reply = `**CPU 사용량:** ${cpuUsage}%\n**메모리 사용량:** ${memUsagePercent}%\n**GPU 사용량:** ${gpuUsage}`;
        await interaction.reply({ content: reply, ephemeral: true });
      } catch (error) {
        console.error('성능 조회 오류:', error);
        await interaction.reply({ content: "성능 정보를 가져오는 중 오류가 발생했습니다.", ephemeral: true });
      }
    }
    else if (commandName === 'performance_detail') {
      try {
        const load = await si.currentLoad();
        const cpuDetails = `**CPU 상세 정보:**
- 현재 부하: ${load.currentLoad.toFixed(2)}%
- 평균 부하 (1분): ${load.avgLoad.toFixed(2)}
- 코어 수: ${load.cpus.length}
- 첫 번째 코어 속도: ${load.cpus[0].speed} GHz`;
        const memData = await si.mem();
        const memUsagePercent = ((memData.used / memData.total) * 100).toFixed(2);
        const memDetails = `**메모리 상세 정보:**
- 총 메모리: ${(memData.total / (1024**3)).toFixed(2)} GB
- 사용 중: ${(memData.used / (1024**3)).toFixed(2)} GB
- 여유 메모리: ${(memData.free / (1024**3)).toFixed(2)} GB
- 사용률: ${memUsagePercent}%`;
        const graphics = await si.graphics();
        let gpuDetails = '**GPU 상세 정보:**\n';
        if (graphics.controllers && graphics.controllers.length > 0) {
          graphics.controllers.forEach((gpu, idx) => {
            gpuDetails += `-- GPU ${idx + 1} --\n`;
            gpuDetails += `이름: ${gpu.model}\n`;
            gpuDetails += `메모리: ${gpu.vram} MB\n`;
            gpuDetails += `온도: ${gpu.temperatureGpu != null ? gpu.temperatureGpu + '°C' : 'N/A'}\n`;
            gpuDetails += `부하: ${gpu.utilizationGpu != null ? gpu.utilizationGpu + '%' : '정보 없음'}\n\n`;
          });
        } else {
          gpuDetails += "GPU 정보가 없습니다.\n";
        }
        const reply = `${cpuDetails}\n\n${memDetails}\n\n${gpuDetails}`;
        await interaction.reply({ content: reply, ephemeral: true });
      } catch (error) {
        console.error('성능 상세 조회 오류:', error);
        await interaction.reply({ content: "상세 성능 정보를 가져오는 중 오류가 발생했습니다.", ephemeral: true });
      }
    }
  }
  // 버튼 인터랙션 처리 (EULA 동의 버튼)
  else if (interaction.isButton()) {
    if (interaction.customId === 'eula_agree') {
      const modal = new ModalBuilder()
        .setCustomId('eula_modal')
        .setTitle('개인정보처리방침 동의');
      
      const nameInput = new TextInputBuilder()
        .setCustomId('eula_input')
        .setLabel('이름 또는 유저 ID를 입력하세요')
        .setStyle(TextInputStyle.Short)
        .setRequired(true);
      
      const actionRow = new ActionRowBuilder().addComponents(nameInput);
      modal.addComponents(actionRow);
      
      await interaction.showModal(modal);
    }
  }
  // 모달 제출 처리 (EULA 동의 후)
  else if (interaction.isModalSubmit()) {
    if (interaction.customId === 'eula_modal') {
      const userInput = interaction.fields.getTextInputValue('eula_input');
      storeUserEula(interaction.user.id, userInput);
      await interaction.reply({ content: "동의가 완료되었습니다. 이제 봇을 사용할 수 있습니다.", ephemeral: true });
    }
  }
});

client.login(token);
