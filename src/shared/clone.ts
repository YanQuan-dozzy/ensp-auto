/**
 * 结构化深拷贝（纯 JSON 语义）。
 *
 * 为什么不用 `structuredClone`：它不能处理 JSON 里不会出现的值（函数、类实例），
 * 而这些数据全部要落盘成 JSON —— 用 JSON 往返能保证「内存里的形状」与
 * 「磁盘上的形状」一致，不会出现「写下去才发现序列化不了」的意外。
 *
 * 出现的场合：所有从 JSON 文件读出来的配置/索引，都要先深拷贝一份再交给调用方，
 * 避免调用方就地修改污染 store 的内存状态。
 */
export function structuredCloneSafe<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T
}
