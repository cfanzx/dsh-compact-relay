
    /**
     * 装配浏览器半。
     * @param {object} ctx 客户端根上下文
     */
    function apply(ctx) {
      /**
       * 等新会话进入会话列表后把主视图切过去。
       * 新会话是 host 侧刚创建的：客户端 catalog 需要一次推送/拉取才认识它。
       * @param {string} sessionId
       */
      const openChildSession = async (sessionId) => {
        if (typeof sessionId !== 'string' || !/^session-.+/.test(sessionId)) {
          throw new Error('缺少新会话 id');
        }
        let lastError = null;
        for (let attempt = 0; attempt < 30; attempt += 1) {
          let known = false;
          try {
            const snapshot = ctx.sessions.list.getSnapshot();
            known = snapshot !== undefined && snapshot.byId !== undefined && snapshot.byId[sessionId] !== undefined;
          } catch (error) {
            lastError = error;
          }
          if (known) {
            try {
              ctx.uiWorkspace.openSession(sessionId);
              return;
            } catch (error) {
              lastError = error;
            }
          } else if (attempt === 2 || attempt === 8 || attempt === 16) {
            try {
              ctx.sessions.refresh();
            } catch (error) {
              lastError = error;
            }
          }
          await sleep(400);
        }
        // 最后一次尝试：catalog 可能滞后，但 retain 已经认识它。
        try {
          ctx.uiWorkspace.openSession(sessionId);
        } catch (error) {
          throw lastError ?? error;
        }
      };

      ctx.slots.inject('conversation.input.left', () =>
        ctx.slots.register(
          {
            name: 'conversation.input.left',
            id: 'compact-relay',
            inject: (sessionId) => ({
              sessionId,
              waitAndOpen: openChildSession,
            }),
          },
          CompactRelayIndicator,
        ),
      );

      // /handoff 命令卡：成功后自动切换（key 必须等于命令名）。
      ctx.slots.inject('conversation.chat.commandview', () =>
        ctx.slots.register(
          {
            name: 'conversation.chat.commandview',
            key: 'handoff',
            inject: () => ({ waitAndOpen: openChildSession }),
          },
          HandoffCard,
        ),
      );

      // 设置栏：官方「设置」左侧新增一节「压缩接力」（第三方插件走 settings.section）。
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: 'compact-relay',
            order: 110,
            label: () => '压缩接力',
          },
          CompactRelaySettings,
        ),
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
