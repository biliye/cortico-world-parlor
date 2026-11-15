type ImageOptions = { priority?: 'low'; onError?: () => void };

/** 支持解码的浏览器等到可绘制。旧内核用 load 和 error 事件。 */
export async function decodeImage(url: string, priority?: ImageOptions['priority']): Promise<void> {
  const image = new Image();
  if (priority) image.fetchPriority = priority;
  if (typeof image.decode === 'function') {
    image.src = url;
    return image.decode();
  }
  return new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error('图片加载失败'));
    image.src = url;
  });
}

/** 等人时先加载。真正需要画牌后，失败只补试一次；并发调用共用请求。 */
export function tableImage(url: string, ready: () => void, { priority, onError }: ImageOptions = {}): (visible?: boolean) => void {
  let state: 'idle' | 'loading' | 'ready' | 'failed' = 'idle';
  let visible = false;
  let retried = false;

  function load(): void {
    state = 'loading';
    void decodeImage(url, priority).then(() => {
      state = 'ready';
      ready();
    }, () => {
      state = 'failed';
      onError?.();
      retryIfVisible();
    });
  }

  function retryIfVisible(): void {
    if (state !== 'failed' || !visible || retried) return;
    retried = true;
    state = 'loading';
    setTimeout(load, 500);
  }

  return (inUse = false) => {
    visible ||= inUse;
    if (state === 'idle') load();
    else retryIfVisible();
  };
}
