'use strict';

/**
 * 转出口：真正的实现搬到了 `src/core/nightly-task.js`。
 *
 * 为什么搬：设置页里现在也能改时间、能删任务（候选②），主进程必须有同一套
 * 「参数怎么拼、输出怎么读」的逻辑。两处各写一份迟早会走样（比如一边加了 /RL、
 * 另一边没加），所以只留一份实现，脚本这边转出去。
 */

module.exports = require('../../src/core/nightly-task');
