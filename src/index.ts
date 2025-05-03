// --- START OF FILE index.ts ---

import { Context, Schema, h, Session, Logger } from 'koishi';
import fs from 'fs';
import path from 'path';
import { URL } from 'url';
// 引入 silk 服务的类型
import SilkService from 'koishi-plugin-silk';

// 动态加载 file-type 的类型
import type { FileTypeResult } from 'file-type';

let fileTypeFromBuffer: ((buffer: Buffer | Uint8Array) => Promise<FileTypeResult | undefined>) | null = null;

export const name = 'save-audio';

// 依赖注入
export const inject = ['silk'] as const;

// 扩展 Context 类型
declare module 'koishi' {
  interface Context {
    silk: SilkService;
  }
}

// 配置接口
export interface Config {
  savePath?: string;
  filenamePattern?: string;
  knownAudioExtensionsInput?: string;
  saveCmdName?: string;
  sendCmdName?: string;
  listCmdName?: string;
  deleteCmdName?: string;
  renameCmdName?: string;
}

// 配置项 Schema 定义
export const Config: Schema<Config> = Schema.object({
  savePath: Schema.string().description('语音文件的保存目录。默认为 Koishi 数据目录下的 `saved_audio`。').default('./data/saved_audio'),
  filenamePattern: Schema.string().description(
    '保存文件名格式 (不含扩展名)。' +
    '可用占位符: {dateTimeFormatted} (格式: YYYYMMDD_HHMMSS), {timestamp} (毫秒时间戳), ' +
    '{userId}, {userName}, {channelId}, {platform}, {originalName}。'
  ).default('{dateTimeFormatted}_{userName}_{originalName}'),
  knownAudioExtensionsInput: Schema.string()
    .role('textarea')
    .description('有效的音频文件扩展名列表，请用英文逗号 (,) 分隔。用于查找和识别文件，不区分大小写，请包含点号 (例如 .mp3,.wav,.slk)。')
    .default('.slk,.wav,.mp3,.ogg,.aac,.m4a,.opus,.amr,.silk'),
  saveCmdName: Schema.string().description('保存语音的命令名。').default('保存语音'),
  sendCmdName: Schema.string().description('发送已保存语音的命令名。').default('发送语音'),
  listCmdName: Schema.string().description('列出已保存语音的命令名。').default('列表语音'),
  deleteCmdName: Schema.string().description('删除已保存语音的命令名。').default('删除语音'),
  renameCmdName: Schema.string().description('重命名已保存语音的命令名。').default('重命名语音'),
});

// 提取的音频数据结构
interface ExtractedAudioData {
  buffer: Buffer;
  sourceUrl?: string;
  originalPath?: string;
}

// 清理并规范化文件名（去除非法字符）
function sanitizeBasename(inputName: string): string {
  return inputName
    .replace(/[^\p{L}\p{N}a-zA-Z0-9_.-]/gu, '_') // 替换所有非字母、数字、下划线、点、减号的字符为下划线
    .replace(/_{2,}/g, '_') // 合并连续下划线
    .replace(/^_|_$/g, '') // 移除开头和结尾的下划线
    .replace(/^\.+$/, '_') // 防止文件名仅由点组成
    .trim(); // 去除首尾空格
}

// 从消息元素中提取音频 Buffer
async function extractRawAudioBuffer(
  ctx: Context,
  elements: h[],
  sourceDescription: string // 用于错误消息，例如 "引用的消息"
): Promise<ExtractedAudioData | string> { // 成功返回数据，失败返回错误消息字符串
  const logger = ctx.logger(name);
  try {
    const audioElements = h.select(elements, 'audio');
    if (audioElements.length === 0) {
      return `在 ${sourceDescription} 中未找到有效的语音或音频元素。`;
    }
    const audioAttrs = audioElements[0].attrs;
    let audioBuffer: Buffer | null = null;
    const sourceUrl: string | undefined = audioAttrs.src;
    const originalPath: string | undefined = audioAttrs.path;

    // 优先尝试本地路径
    if (originalPath) {
      try {
        audioBuffer = await fs.promises.readFile(originalPath);
      } catch (fsError: any) {
        // 如果不是文件不存在错误，记录一下，否则静默处理（后面会尝试URL）
        if (fsError?.code !== 'ENOENT') {
          logger.error(`[Extract] 读取本地文件 (${originalPath}) 失败: %s`, fsError?.message || fsError);
        }
        audioBuffer = null; // 确保置空，以便尝试 URL
        if (!sourceUrl) {
          logger.error(`[Extract] 读取本地文件 (${originalPath}) 失败，且无 URL 可用。`);
          return `无法读取本地文件 (${originalPath})，且无网络地址可供下载：${fsError?.message || fsError}`;
        }
      }
    }

    // 如果本地读取失败或没有本地路径，尝试从 URL 下载
    if (!audioBuffer && sourceUrl) {
      const looksLikeMetadata = (str: string) => str.includes('_file_') || str.includes('_path_') || str.includes('file-size') || str.length > 100;
      if (looksLikeMetadata(sourceUrl)) {
        // 如果 URL 看起来像元数据而不是可下载地址，则跳过下载
        logger.info(`[Extract] sourceUrl "${sourceUrl.substring(0, 100)}..." 看起来像元数据，跳过下载。`);
      } else {
        try {
          const response = await ctx.http.get(sourceUrl, { responseType: 'arraybuffer', timeout: 30000 });
          audioBuffer = Buffer.from(response);
        } catch (error: any) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          logger.error(`[Extract] 无法从 URL (${sourceUrl}) 获取音频: %s`, errorMessage);
          let baseMessage = `无法获取 ${sourceDescription} 的音频：`;
          try {
            new URL(sourceUrl); // 检查URL是否有效
          } catch {
            // URL 格式无效
            if (originalPath) {
              return `${baseMessage}读取本地文件 (${originalPath}) 失败，提供的 src 也不是有效的 URL (${sourceUrl})。`;
            } else {
              return `${baseMessage}提供的 src 不是有效的 URL (${sourceUrl})。`;
            }
          }
          // URL 有效但下载失败
          if (originalPath) {
            return `${baseMessage}读取本地文件 (${originalPath}) 失败，尝试从 URL (${sourceUrl}) 下载也失败 (${errorMessage})。`;
          }
          return `${baseMessage}网络请求失败 (${errorMessage})。`;
        }
      }
    }


    // 最终检查是否成功获取到 Buffer
    if (!audioBuffer || audioBuffer.length === 0) {
      return `未能获取 ${sourceDescription} 的有效音频数据（已尝试本地路径和网络地址）。`;
    }

    return { buffer: audioBuffer, sourceUrl, originalPath };
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`[Extract] 从 "${sourceDescription}" 提取音频 Buffer 时发生意外错误: %s`, errorMessage, error);
    return `提取 ${sourceDescription} 的音频数据时发生内部错误：${errorMessage}`;
  }
}

// 根据模式和信息生成文件名（不含扩展名）和尝试推断的扩展名
function generateFilename(
  pattern: string,
  session: Session,
  knownAudioExtensionsLower: string[],
  sourceUrl?: string,
  originalPath?: string,
  logger?: Logger // 可选的 logger
): { baseName: string, attemptedExt: string | null } {
  const timestamp = Date.now();
  const now = new Date(timestamp);
  const dateTimeFormatted = `${now.getFullYear()}${(now.getMonth() + 1).toString().padStart(2, '0')}${now.getDate().toString().padStart(2, '0')}_${now.getHours().toString().padStart(2, '0')}${now.getMinutes().toString().padStart(2, '0')}${now.getSeconds().toString().padStart(2, '0')}`;

  let originalName = 'unknown';
  let attemptedExt: string | null = null;
  let sourceIdentifier = originalPath || sourceUrl;

  // 检查标识符是否像内部元数据
  const looksLikeMetadata = (str: string | undefined | null): boolean => {
    if (!str) return false;
    return str.includes('_file_') || str.includes('_path_') || str.includes('file-size') || str.length > 100;
  };

  if (sourceIdentifier && !looksLikeMetadata(sourceIdentifier)) {
    let filenamePart = '';
    try {
      // 尝试从 URL 或路径中提取文件名部分
      if (sourceIdentifier.startsWith('http:') || sourceIdentifier.startsWith('https:')) {
        const parsedUrl = new URL(sourceIdentifier);
        filenamePart = path.basename(decodeURIComponent(parsedUrl.pathname));
        // 特殊处理 data URI
        if (sourceIdentifier.startsWith('data:')) {
          filenamePart = 'data_uri_audio';
        }
      } else {
        filenamePart = path.basename(sourceIdentifier);
      }

      if (filenamePart && !looksLikeMetadata(filenamePart)) {
        const ext = path.extname(filenamePart).toLowerCase();
        // 如果有扩展名且在已知列表或通用后缀中，则分离基础名和扩展名
        if (ext && filenamePart.length > ext.length) {
          originalName = filenamePart.substring(0, filenamePart.length - ext.length);
          if (knownAudioExtensionsLower.includes(ext) || ['.bin', '.audio'].includes(ext)) {
            attemptedExt = ext;
          } else {
            // 未知扩展名，将整个部分视为原始名
            originalName = filenamePart;
            attemptedExt = null;
          }
        } else if (filenamePart.length > 0) {
          // 没有扩展名，整个部分是原始名
          originalName = filenamePart;
        }
        // 再次检查提取出的 originalName 是否像元数据
        if (looksLikeMetadata(originalName)) {
          originalName = 'audio';
          attemptedExt = null;
        }
      } else {
        // 如果提取的文件名部分像元数据或为空，使用默认名
        originalName = 'audio';
      }
    } catch (e: unknown) {
      // 解析失败，尝试直接用 basename，如果还失败或像元数据，则用默认值
      logger?.error(`[Filename Gen] 解析源标识符 "${sourceIdentifier}" 失败: ${e instanceof Error ? e.message : e}`);
      try {
        originalName = path.basename(sourceIdentifier);
        if (looksLikeMetadata(originalName)) {
          originalName = 'audio';
        }
      } catch {
        originalName = 'audio';
      }
      attemptedExt = null;
    }
  } else {
    // 没有源标识符或标识符像元数据，使用默认原始名
    originalName = 'audio';
  }

  // 清理原始名并限制长度
  const MAX_ORIG_NAME_LEN = 50;
  originalName = sanitizeBasename(originalName);
  if (originalName.length > MAX_ORIG_NAME_LEN) {
    originalName = originalName.substring(0, MAX_ORIG_NAME_LEN) + '...';
  }
  if (!originalName) { // 防止清理后变空
    originalName = 'audio';
  }

  // 替换占位符
  const replacements: Record<string, string> = {
    '{timestamp}': String(timestamp),
    '{dateTimeFormatted}': dateTimeFormatted,
    '{userId}': session.userId || 'unknownUser',
    '{userName}': session.author?.nickname || session.author?.name || `user_${session.userId?.substring(0, 4) || 'unknown'}`,
    '{channelId}': session.channelId || 'unknownChannel',
    '{platform}': session.platform || 'unknownPlatform',
    '{originalName}': originalName,
  };

  let baseName = pattern;
  for (const placeholder in replacements) {
    try {
      const regex = new RegExp(placeholder.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&'), 'g');
      baseName = baseName.replace(regex, replacements[placeholder]);
    } catch (replaceError) {
      logger?.error(`[Filename Gen] 替换占位符 "${placeholder}" 时出错: ${replaceError}`);
    }
  }

  // 清理最终的基础文件名
  baseName = sanitizeBasename(baseName);
  if (!baseName) { // 防止模式和替换后变空
    baseName = `audio_${dateTimeFormatted}`;
  }

  return { baseName, attemptedExt };
}


// Koishi 插件主逻辑
export function apply(ctx: Context, config: Config) {
  const logger = ctx.logger(name);
  const absoluteSavePath = path.resolve(ctx.baseDir, config.savePath || './data/saved_audio');
  // 处理配置中的扩展名列表
  const rawExtensionsString = config.knownAudioExtensionsInput || '.slk,.wav,.mp3,.ogg,.aac,.m4a,.opus,.amr,.silk';
  const knownExtsLower = rawExtensionsString
    .split(',')
    .map(ext => ext.trim())
    .filter(ext => ext.length > 0)
    .map(ext => (ext.startsWith('.') ? ext.toLowerCase() : `.${ext.toLowerCase()}`));

  // 确保 .bin 作为后备扩展名存在
  if (!knownExtsLower.includes('.bin')) {
    knownExtsLower.push('.bin');
  }

  // 检查字符串是否像元数据（用于过滤用户输入的文件名）
  const looksLikeMetadata = (str: string | undefined | null): boolean => {
    if (!str) return false;
    return str.includes('_file_') || str.includes('_path_') || str.includes('file-size') || str.length > 100;
  };

  // 插件就绪事件
  ctx.on('ready', async () => {
    try {
      await fs.promises.mkdir(absoluteSavePath, { recursive: true });
      logger.info(`音频将保存到目录: ${absoluteSavePath}`);
    } catch (error: unknown) {
      logger.error(`创建保存目录 (${absoluteSavePath}) 失败: %s`, error instanceof Error ? error.message : error);
    }
    // 尝试动态加载 file-type
    try {
      const ft = await import('file-type');
      fileTypeFromBuffer = ft.fromBuffer;
      if (typeof fileTypeFromBuffer !== 'function') {
        logger.error('动态导入 file-type 成功，但 fromBuffer 函数未找到！');
        fileTypeFromBuffer = null;
      }
    } catch (err) {
      logger.error('动态导入 file-type 失败，文件类型检测功能将受限: %s', err);
      fileTypeFromBuffer = null;
    }
  });

  // 保存语音命令
  ctx.command(`${config.saveCmdName} [customName:string]`, '保存回复的语音消息')
    .alias('saveaudio')
    .option('overwrite', '-o 强制覆盖同名文件', { fallback: false })
    .usage(
      `功能: 保存回复的语音到服务器。\n` +
      `用法 1: 回复语音消息，发送 "${config.saveCmdName}" (自动生成文件名)。\n` +
      `用法 2: 回复语音消息，发送 "${config.saveCmdName} 我的自定义名称" (使用指定文件名，无需扩展名)。\n` +
      `选项: -o 或 --overwrite 可强制覆盖同名文件 (基于基础文件名检查)。\n` +
      `注意: 文件名特殊字符会被替换。保存位置: ${config.savePath}\n` +
      `文件名格式 (自动): ${config.filenamePattern.replace('{dateTimeFormatted}', 'YYYYMMDD_HHMMSS').replace('{originalName}', '原始名或audio')}\n` +
      `文件名格式 (指定): <自定义名称>`
    )
    .action(async ({ session, args, options }) => {
      const startTime = Date.now();
      if (!session?.quote) return '请回复一条包含语音的消息。';

      // 提取音频数据
      const audioDataResult = await extractRawAudioBuffer(ctx, session.quote.elements, '引用的消息');
      if (typeof audioDataResult === 'string') {
        return audioDataResult; // 返回错误信息
      }
      const { buffer, sourceUrl, originalPath } = audioDataResult;

      let baseName: string;
      let attemptedExt: string | null = null;
      const providedName = args?.[0]?.trim();
      let useEffectiveProvidedName = false; // 标记是否使用了有效的用户提供名称

      // 处理用户提供的自定义名称
      if (providedName) {
        if (looksLikeMetadata(providedName)) {
          // 如果看起来像元数据，则忽略用户输入，后续使用模式生成
        } else {
          baseName = sanitizeBasename(providedName);
          if (!baseName) {
            return '错误：提供的自定义文件名无效或清理后为空。';
          }
          useEffectiveProvidedName = true;
          // 尝试从源信息猜测扩展名，即使使用了自定义基础名
          try {
            const { attemptedExt: guessedExt } = generateFilename(config.filenamePattern, session, knownExtsLower, sourceUrl, originalPath);
            attemptedExt = guessedExt;
          } catch { }
        }
      }

      // 如果没有使用有效的自定义名称，则按模式生成
      if (!useEffectiveProvidedName) {
        try {
          ({ baseName, attemptedExt } = generateFilename(config.filenamePattern, session, knownExtsLower, sourceUrl, originalPath, logger));
        } catch (e: unknown) {
          logger.error('[Save] 生成文件名出错: %s', e instanceof Error ? e.message : e);
          return `生成文件名时出错：${e instanceof Error ? e.message : e}`;
        }
      }

      // 文件类型检测
      let detectedExt = '.bin', detectedMime = 'application/octet-stream', durationInfo = '';
      try {
        // 优先使用 silk 插件检测
        if (ctx.silk?.isSilk && ctx.silk.isSilk(buffer)) {
          detectedExt = '.slk';
          detectedMime = 'audio/silk';
          try { // 尝试获取时长
            if (ctx.silk?.getDuration) {
              const duration = ctx.silk.getDuration(buffer);
              durationInfo = ` (时长: ${Math.round(duration / 1000)}s)`;
            }
          } catch { } // 获取时长失败不阻塞
        } else if (fileTypeFromBuffer) { // 其次使用 file-type
          const fileTypeResult = await fileTypeFromBuffer(buffer);
          if (fileTypeResult) {
            detectedExt = `.${fileTypeResult.ext}`;
            detectedMime = fileTypeResult.mime;
          }
        }
      } catch (e) {
        logger.error(`[Save] 检测文件类型时出错: %s`, e instanceof Error ? e.message : e);
        // 出错不影响后续，使用默认 .bin
      }

      // 如果检测结果是默认后备，但我们从源信息推断出了已知扩展名，则使用推断的
      if ((detectedExt === '.bin') && attemptedExt && knownExtsLower.includes(attemptedExt)) {
        detectedExt = attemptedExt;
        detectedMime = 'audio/unknown'; // Mime 类型不确定
      }

      const finalFilename = `${baseName}${detectedExt}`;
      const fullSavePath = path.join(absoluteSavePath, finalFilename);

      // 检查文件是否存在及处理覆盖逻辑
      let isOverwriting = false;
      try {
        const directoryFiles = await fs.promises.readdir(absoluteSavePath);
        let existingFilenameWithSameBase: string | null = null;

        for (const file of directoryFiles) {
          const currentBaseName = path.basename(file, path.extname(file));
          // 不区分大小写比较基础文件名
          if (currentBaseName.toLowerCase() === baseName.toLowerCase()) {
            existingFilenameWithSameBase = file;
            break;
          }
        }

        if (existingFilenameWithSameBase) {
          const existingFullPath = path.join(absoluteSavePath, existingFilenameWithSameBase);
          // 检查是否是完全相同的文件路径（包括扩展名）
          if (fullSavePath.toLowerCase() === existingFullPath.toLowerCase()) {
            if (!options.overwrite) {
              return `错误：名为 "${baseName}" 的语音已存在 (${existingFilenameWithSameBase})。请使用不同名称、先删除或使用 -o 参数覆盖。`;
            } else {
              isOverwriting = true; // 允许覆盖同名同扩展文件
            }
          } else {
            // 存在同基础名但不同扩展名的文件
            if (!options.overwrite) {
              return `错误：已存在名为 "${baseName}" 的语音文件 (${existingFilenameWithSameBase})。请使用不同名称、先删除或使用 -o 参数强制保存为 "${finalFilename}"。`;
            } else {
              // 检查目标文件本身是否存在
              try {
                await fs.promises.access(fullSavePath, fs.constants.F_OK);
                // 目标文件也存在，需要覆盖
                isOverwriting = true;
              } catch (accessError: any) {
                if (accessError.code === 'ENOENT') {
                  // 目标文件不存在，即使有同名不同扩展的文件，也允许写入新文件
                  isOverwriting = false;
                } else {
                  throw accessError; // 其他访问错误
                }
              }
            }
          }
        }
        // 如果没有找到同基础名的文件，则 isOverwriting 保持 false

      } catch (error: any) {
        if (error.code === 'ENOENT') {
          // 目录不存在是允许的，尝试创建（尽管 ready 时已尝试过）
          try {
            await fs.promises.mkdir(absoluteSavePath, { recursive: true });
          } catch (mkdirError: any) {
            logger.error(`[Save] 检查文件存在性时目录不存在，且创建目录失败: %s`, mkdirError?.message || mkdirError);
            return `检查文件是否存在时出错：无法访问或创建目录 (${config.savePath})。`;
          }
        } else {
          // 其他读取目录的错误
          const msg = error instanceof Error ? error.message : String(error);
          logger.error(`[Save] 检查文件存在性时出错 (${baseName}): %s`, msg, error);
          return `检查文件是否存在时出错：${msg}`;
        }
      }

      // 写入文件
      try {
        await fs.promises.writeFile(fullSavePath, buffer);
        const duration = Date.now() - startTime;
        const actionVerb = isOverwriting ? '覆盖保存' : '成功保存';
        let successMessage = `语音已${actionVerb}为：\n${baseName}${durationInfo}`;
        if (detectedExt === '.slk' || detectedExt === '.silk') {
          successMessage += `\n(格式: ${detectedExt})`;
        }
        return successMessage;
      } catch (writeError: unknown) {
        const msg = writeError instanceof Error ? writeError.message : String(writeError);
        logger.error(`[Save] 写入文件失败 (${fullSavePath}): %s`, msg, writeError);
        return `保存语音文件时出错：${msg}`;
      }
    }); // --- End of save action ---

  // 列出语音命令
  ctx.command(`${config.listCmdName}`, '列出已保存的语音文件 (仅基础名)')
    .alias('listaudio')
    .usage(
      `功能: 显示保存在 "${config.savePath}" 目录下的音频文件。\n` +
      `用法: 直接发送 "${config.listCmdName}"。\n` +
      `输出带编号的文件名列表 (不含扩展名)。`
    )
    .action(async () => {
      try {
        const files = await fs.promises.readdir(absoluteSavePath);
        const audioFilesData = files
          .map(file => ({
            filename: file,
            basename: path.basename(file, path.extname(file)),
            ext: path.extname(file).toLowerCase()
          }))
          .filter(data => knownExtsLower.includes(data.ext)); // 只显示已知扩展名的文件

        if (audioFilesData.length === 0) {
          return `"${config.savePath}" 目录中没有找到已保存的语音文件。`;
        }

        audioFilesData.sort((a, b) => a.basename.localeCompare(b.basename)); // 按基础名排序

        let message = `已保存的语音文件 (共 ${audioFilesData.length} 个):\n`;
        message += audioFilesData
          .map((data, index) => `${index + 1}. ${data.basename}`) // 显示带编号的基础名
          .join('\n');

        return message;

      } catch (error: any) {
        if (error.code === 'ENOENT') {
          return `语音保存目录不存在: ${config.savePath}`;
        }
        const msg = error instanceof Error ? error.message : String(error);
        logger.error(`[List] 读取目录失败 (${absoluteSavePath}): %s`, msg, error);
        return `列出语音文件时出错：${msg}`;
      }
    });

  // 发送语音命令
  ctx.command(`${config.sendCmdName} <baseName:string>`, '发送已保存的语音文件 (输入基础名)')
    .alias('sendaudio')
    .usage(
      `功能: 发送一个已保存的语音文件。\n` +
      `用法: ${config.sendCmdName} 文件基础名。\n` +
      `文件名可通过 "${config.listCmdName}" 查看。\n` +
      `对于 onebot (QQ)，会自动尝试发送 SILK 或将 WAV 转码为 SILK。`
    )
    .action(async ({ session, args }) => {
      if (!session) return '无法获取会话信息。';
      const targetBasename = args?.[0]?.trim();
      if (!targetBasename) {
        return `请输入要发送的文件基础名。使用 "${config.listCmdName}" 查看列表。`;
      }

      let foundFilepath: string | null = null;
      let foundFilename: string | null = null;

      try {
        const files = await fs.promises.readdir(absoluteSavePath);
        // 查找匹配基础名的文件
        for (const file of files) {
          const currentExt = path.extname(file).toLowerCase();
          if (!knownExtsLower.includes(currentExt)) continue; // 跳过未知扩展名

          const currentBasename = path.basename(file, currentExt);
          if (currentBasename.toLowerCase() === targetBasename.toLowerCase()) {
            foundFilepath = path.join(absoluteSavePath, file);
            foundFilename = file;
            break; // 找到第一个匹配项即停止
          }
        }

        if (!foundFilepath || !foundFilename) {
          return `未找到名为 "${targetBasename}" 的语音文件。请检查文件名并使用 "${config.listCmdName}" 查看。`;
        }

        // 读取文件内容
        const fileBuffer = await fs.promises.readFile(foundFilepath);
        const fileExt = path.extname(foundFilename).toLowerCase();
        let bufferToSend: Buffer | null = null;
        let sendAsBase64 = false; // 是否需要 Base64 编码（通常用于 onebot 的 silk）

        // 特殊处理 onebot 平台
        if (session.platform === 'onebot') {
          // 如果是 silk 文件
          if ((fileExt === '.slk' || fileExt === '.silk') && ctx.silk?.isSilk && ctx.silk.isSilk(fileBuffer)) {
            bufferToSend = fileBuffer;
            sendAsBase64 = true;
          }
          // 如果是 wav 文件且 silk 服务支持转换
          else if (fileExt === '.wav' && ctx.silk?.isWav && ctx.silk.isWav(fileBuffer) && ctx.silk?.encode && ctx.silk?.getWavFileInfo) {
            try {
              const wavInfo = ctx.silk.getWavFileInfo(fileBuffer);
              if (!wavInfo?.fmt?.sampleRate) {
                throw new Error('无法获取 WAV 文件的有效采样率');
              }
              const encodeResult = await ctx.silk.encode(fileBuffer, wavInfo.fmt.sampleRate);
              bufferToSend = Buffer.from(encodeResult.data);
              sendAsBase64 = true;
            } catch (encodeError: unknown) {
              const msg = encodeError instanceof Error ? encodeError.message : String(encodeError);
              logger.error(`[Send] WAV 转 SILK 编码失败 (${foundFilename}): %s`, msg, encodeError);
              return `发送失败：无法将 "${targetBasename}" (原格式 ${fileExt}) 编码为 SILK。错误: ${msg}`;
            }
          } else {
            // 其他格式或 silk 服务不完整，无法发送
            return `无法发送 "${targetBasename}"：onebot 平台仅支持发送 SILK 格式语音，或将 WAV 自动转换，不支持 ${fileExt} 或 Silk 功能不完整。`;
          }
        } else {
          // 其他平台，直接发送原始 Buffer
          bufferToSend = fileBuffer;
          sendAsBase64 = false;
        }

        if (!bufferToSend) {
          logger.error('[Send] 内部错误：未能准备好要发送的音频 Buffer。');
          return '内部错误：无法准备要发送的音频数据。';
        }

        // 发送语音
        try {
          if (sendAsBase64) {
            const base64Data = bufferToSend.toString('base64');
            await session.send(h('audio', { src: `base64://${base64Data}` }));
          } else {
            await session.send(h('audio', { src: bufferToSend }));
          }
          // 发送成功后不返回消息
        } catch (sendError: unknown) {
          const msg = sendError instanceof Error ? sendError.message : String(sendError);
          logger.error(`[Send] 发送语音时发生错误 (${foundFilename}): %s`, msg, sendError);
          return `发送语音 "${targetBasename}" 时出错：${msg}`;
        }

      } catch (error: any) {
        if (error.code === 'ENOENT' && !foundFilepath) { // 区分是目录不存在还是文件读取错误
          return `语音保存目录不存在或无法访问: ${config.savePath}`;
        }
        const msg = error instanceof Error ? error.message : String(error);
        logger.error(`[Send] 处理发送命令时发生意外错误 (目标: ${targetBasename}): %s`, msg, error);
        return `发送语音 "${targetBasename}" 时发生内部错误：${msg}`;
      }
    });

  // 删除语音命令
  ctx.command(`${config.deleteCmdName} <baseNames:text>`, '删除一个或多个已保存的语音文件 (输入基础名)')
    .alias('delaudio')
    .usage(
      `功能: 删除保存在 "${config.savePath}" 的一个或多个语音文件。\n` +
      `用法: ${config.deleteCmdName} 文件基础名1[,，文件基础名2...] \n` +
      `文件名之间用英文逗号 "," 或中文逗号 "，" 分隔。\n` +
      `文件名可通过 "${config.listCmdName}" 查看。`
    )
    .action(async ({ session, args }) => {
      const rawInput = args?.[0]?.trim();
      if (!rawInput) {
        return `请输入要删除的文件基础名，多个文件用逗号分隔。使用 "${config.listCmdName}" 查看列表。`;
      }

      // 解析输入，支持中英文逗号
      const targetBasenames = rawInput
        .replace(/，/g, ',')
        .split(',')
        .map(name => name.trim())
        .filter(name => name.length > 0);

      if (targetBasenames.length === 0) {
        return '请输入有效的、用逗号分隔的文件基础名。';
      }

      const filesToDelete: { path: string, basename: string, filename: string }[] = [];
      const foundBaseNamesLower = new Set<string>(); // 记录找到的基础名（小写）
      const notFoundBaseNames: string[] = [];       // 未找到的文件基础名
      const deletedBaseNames: string[] = [];        // 成功删除的文件基础名
      const failedToDelete: { basename: string, reason: string }[] = []; // 删除失败的文件

      let directoryFiles: string[] = [];
      try {
        directoryFiles = await fs.promises.readdir(absoluteSavePath);
      } catch (error: any) {
        if (error.code === 'ENOENT') {
          return `操作失败：语音保存目录不存在 (${config.savePath})。`;
        }
        const msg = error instanceof Error ? error.message : String(error);
        logger.error(`[Delete] 读取目录失败 (${absoluteSavePath}): %s`, msg, error);
        return `删除语音文件时出错：无法读取目录 (${msg})。`;
      }

      // 查找要删除的文件
      for (const targetName of targetBasenames) {
        const targetNameLower = targetName.toLowerCase();
        let foundMatch = false;
        for (const file of directoryFiles) {
          const currentExt = path.extname(file).toLowerCase();
          if (!knownExtsLower.includes(currentExt)) continue; // 跳过未知类型

          const currentBasename = path.basename(file, currentExt);
          if (currentBasename.toLowerCase() === targetNameLower) {
            const fullPath = path.join(absoluteSavePath, file);
            // 防止重复添加（如果用户输入了相同的基础名多次）
            if (!filesToDelete.some(f => f.path.toLowerCase() === fullPath.toLowerCase())) {
              filesToDelete.push({ path: fullPath, basename: currentBasename, filename: file });
              foundBaseNamesLower.add(targetNameLower);
            }
            foundMatch = true;
            // 注意：这里不 break，因为可能存在同基础名不同扩展名的文件，理论上应该都删除？
            // 当前逻辑是找到一个就认为找到了，如果需要删除所有同基础名文件，需修改这里。
            // 考虑到用户是按基础名删除，找到一个匹配就算找到了。
          }
        }
        // 如果遍历完目录都没找到这个基础名，且之前也没找到过
        if (!foundMatch && !foundBaseNamesLower.has(targetNameLower)) {
          notFoundBaseNames.push(targetName);
        }
      }

      if (filesToDelete.length === 0 && notFoundBaseNames.length > 0) {
        return `未能找到要删除的文件: ${notFoundBaseNames.join(', ')}。请使用 "${config.listCmdName}" 检查。`;
      }
      if (filesToDelete.length === 0) {
        return `没有找到任何需要删除的文件。`;
      }


      // 执行删除操作
      for (const fileInfo of filesToDelete) {
        try {
          await fs.promises.unlink(fileInfo.path);
          // 记录成功删除的基础名（去重）
          if (!deletedBaseNames.includes(fileInfo.basename)) {
            deletedBaseNames.push(fileInfo.basename);
          }
        } catch (deleteError: any) {
          const reason = deleteError instanceof Error ? deleteError.message : String(deleteError);
          failedToDelete.push({ basename: fileInfo.basename, reason });
          logger.error(`[Delete] 删除文件失败 (${fileInfo.path}): %s`, reason, deleteError);
        }
      }

      // 构建反馈消息
      let message = '';
      if (deletedBaseNames.length > 0) {
        message += `成功删除 ${deletedBaseNames.length} 个语音:\n${deletedBaseNames.join('\n')}\n`;
      }
      if (notFoundBaseNames.length > 0) {
        message += `\n未找到以下名称对应的语音文件:\n${notFoundBaseNames.join('\n')}\n`;
      }
      if (failedToDelete.length > 0) {
        message += `\n删除以下语音时遇到错误:\n${failedToDelete.map(f => `${f.basename} (${f.reason})`).join('\n')}\n`;
      }

      return message.trim() || '删除操作已完成，但似乎没有文件被删除。'; // 兜底消息
    });

  // 重命名语音命令
  ctx.command(`${config.renameCmdName} <oldBaseName:string> <newBaseName:string>`, '重命名一个已保存的语音文件 (输入基础名)')
    .alias('renameaudio')
    .usage(
      `功能: 重命名一个已保存的语音文件 (保持扩展名不变)。\n` +
      `用法: ${config.renameCmdName} 旧基础名 新基础名\n` +
      `例如: ${config.renameCmdName} audio_123 my_sound\n` +
      `注意: 如果新基础名已被其他语音使用，操作将失败。\n` +
      `文件名可通过 "${config.listCmdName}" 查看。`
    )
    .action(async ({ session, args }) => {
      const oldBaseName = args?.[0]?.trim();
      const rawNewBaseName = args?.[1]?.trim();

      if (!oldBaseName || !rawNewBaseName) {
        return `请输入旧文件名和新文件名 (都不含扩展名)。\n用法: ${config.renameCmdName} <旧基础名> <新基础名>`;
      }

      // 清理新文件名
      const newBaseName = sanitizeBasename(rawNewBaseName);
      if (!newBaseName) {
        return `错误：提供的新文件名无效或清理后为空。`;
      }
      if (newBaseName.toLowerCase() === oldBaseName.toLowerCase()) {
        return `错误：新文件名与旧文件名相同。`;
      }

      let foundOldPath: string | null = null;
      let foundOldFilename: string | null = null;
      let originalExtension: string | null = null; // 保留原始扩展名

      let directoryFiles: string[] = [];
      try {
        directoryFiles = await fs.promises.readdir(absoluteSavePath);
      } catch (error: any) {
        if (error.code === 'ENOENT') {
          return `操作失败：语音保存目录不存在 (${config.savePath})。`;
        }
        const msg = error instanceof Error ? error.message : String(error);
        logger.error(`[Rename] 读取目录失败 (${absoluteSavePath}): %s`, msg, error);
        return `重命名语音文件时出错：无法读取目录 (${msg})。`;
      }

      // 查找旧文件
      for (const file of directoryFiles) {
        const currentExt = path.extname(file).toLowerCase();
        if (!knownExtsLower.includes(currentExt)) continue;

        const currentBasename = path.basename(file, currentExt);
        if (currentBasename.toLowerCase() === oldBaseName.toLowerCase()) {
          foundOldPath = path.join(absoluteSavePath, file);
          foundOldFilename = file;
          originalExtension = path.extname(file); // 获取原始扩展名
          break;
        }
      }

      if (!foundOldPath || !foundOldFilename || originalExtension === null) {
        return `未找到名为 "${oldBaseName}" 的语音文件。请使用 "${config.listCmdName}" 检查。`;
      }

      // 构造新文件路径
      const newFilename = `${newBaseName}${originalExtension}`;
      const newFullPath = path.join(absoluteSavePath, newFilename);

      // 检查新文件名是否已存在 (基于基础名)
      let newBaseNameExists = false;
      let conflictingFilename: string | null = null;
      for (const file of directoryFiles) {
        // 跳过自身
        if (path.join(absoluteSavePath, file).toLowerCase() === foundOldPath.toLowerCase()) {
          continue;
        }
        const currentBasename = path.basename(file, path.extname(file));
        if (currentBasename.toLowerCase() === newBaseName.toLowerCase()) {
          newBaseNameExists = true;
          conflictingFilename = file;
          break;
        }
      }

      if (newBaseNameExists) {
        return `错误：名为 "${newBaseName}" 的语音文件已存在 (文件 "${conflictingFilename}")。请选择其他名称。`;
      }

      // 执行重命名
      try {
        await fs.promises.rename(foundOldPath, newFullPath);
        return `成功将语音 "${oldBaseName}" 重命名为 "${newBaseName}"。`;
      } catch (renameError: unknown) {
        const msg = renameError instanceof Error ? renameError.message : String(renameError);
        logger.error(`[Rename] 重命名文件失败 (${foundOldPath} -> ${newFullPath}): %s`, msg, renameError);
        return `将语音 "${oldBaseName}" 重命名为 "${newBaseName}" 时出错：${msg}`;
      }
    });

  logger.info('增强语音管理器插件已加载。');
}

// --- END OF FILE index.ts ---