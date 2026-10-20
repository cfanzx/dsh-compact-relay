
    /** 主题变化时重新检测 body 明暗（DSH 切主题时 body 背景会变）。 */
    function useAutoTheme() {
      const [theme, setTheme] = useState(() => detectTheme());
      useEffect(() => {
        let raf = 0;
        const schedule = () => {
          if (raf !== 0) return;
          const run = () => {
            raf = 0;
            const next = detectTheme();
            setTheme((prev) =>
              prev.dark === next.dark && prev.panelBg === next.panelBg && prev.panelFg === next.panelFg ? prev : next,
            );
          };
          raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(run) : setTimeout(run, 16);
        };
        const observer = new MutationObserver(schedule);
        for (const target of [document.documentElement, document.body]) {
          if (target) {
            observer.observe(target, {
              attributes: true,
              attributeFilter: ['class', 'style', 'data-theme', 'data-color-scheme', 'data-ds-theme-source', 'data-ds-dark-theme'],
            });
          }
        }
        let media = null;
        try {
          media = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : null;
        } catch {
          media = null;
        }
        const onMedia = () => schedule();
        if (media !== null) {
          if (typeof media.addEventListener === 'function') media.addEventListener('change', onMedia);
          else if (typeof media.addListener === 'function') media.addListener(onMedia);
        }
        return () => {
          observer.disconnect();
          if (raf !== 0) {
            if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf);
            else clearTimeout(raf);
          }
          if (media !== null) {
            if (typeof media.removeEventListener === 'function') media.removeEventListener('change', onMedia);
            else if (typeof media.removeListener === 'function') media.removeListener(onMedia);
          }
        };
      }, []);
      return theme;
    }
