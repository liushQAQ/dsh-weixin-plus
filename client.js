window.__ModuleLoader__.load({
  id: 'dsh-weixin-plus',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useCallback, useRef } = React;

    const RPC_CHANNEL = '/dsh-weixin-plus';

    function WeixinSettingsTab(props) {
      const [data, setData] = useState(null);
      const [loading, setLoading] = useState(true);
      const [actionBusy, setActionBusy] = useState(false);
      const [errorMsg, setErrorMsg] = useState(null);
      const [toastMsg, setToastMsg] = useState(null);

      const connectionRef = useRef(null);

      // 获取 connection 对象（优先从 props 传递，其次从全局 ModuleLoader / Harness 上下文寻找）
      const getConnection = () => {
        if (connectionRef.current) return connectionRef.current;
        if (props?.connection) {
          connectionRef.current = props.connection;
          return props.connection;
        }
        if (props?.ctx?.connection) {
          connectionRef.current = props.ctx.connection;
          return props.ctx.connection;
        }
        // 尝试从全局 DSH 上下文获取
        if (window.__DSH_CONNECTION__) {
          connectionRef.current = window.__DSH_CONNECTION__;
          return window.__DSH_CONNECTION__;
        }
        return null;
      };

      const showToast = (msg) => {
        setToastMsg(msg);
        setTimeout(() => setToastMsg(null), 3000);
      };

      // 统一调用通道：优先走 Cordis Connection RPC，若不在 RPC 上下文中则优雅回退至 HTTP fetch
      const callApi = async (action, payload = {}) => {
        const conn = getConnection();
        // 尝试 RPC 调用
        if (conn && conn.rpc && typeof conn.rpc.call === 'function') {
          try {
            const res = await conn.rpc.call(RPC_CHANNEL, action, payload);
            if (res && res.ok === true) {
              return res.value;
            }
            if (res && res.ok === false) {
              throw new Error(res.error?.message || 'RPC调用失败');
            }
            if (res && typeof res === 'object') {
              return res;
            }
          } catch (rpcErr) {
            console.warn('[dsh-weixin-plus] RPC call failed, falling back to HTTP:', rpcErr);
            // 若不是取消操作，继续向下回退至 HTTP
          }
        }

        // 回退 HTTP fetch
        // 🔴 filepush19：HTTP 备用口已从 /dsh-weixin-plus 挪到 /dsh-weixin-plus-http
        //   （RPC 通道占着 /dsh-weixin-plus，同 prefix+path 会 duplicate prefix route）。
        const baseUrl = (typeof window !== 'undefined' && window.location && window.location.pathname.startsWith('/dsh/')) ? '/dsh/dsh-weixin-plus-http/' : '/dsh-weixin-plus-http/';
        const res = await fetch(baseUrl + action, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-dsh-desktop-renderer': '1'
          },
          body: JSON.stringify(payload),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
      };

      const fetchStatus = useCallback(async (isSilent = false) => {
        if (!isSilent) setLoading(true);
        try {
          const res = await callApi('status');
          if (res && res.ok) {
            setData(res);
            setErrorMsg(null);
          } else {
            throw new Error(res?.error || '获取状态失败');
          }
        } catch (err) {
          if (!isSilent) setErrorMsg('获取微信通道状态失败: ' + err.message);
        } finally {
          if (!isSilent) setLoading(false);
        }
      }, []);

      useEffect(() => {
        fetchStatus(false);
        const timer = setInterval(() => {
          fetchStatus(true);
        }, 3000);
        return () => clearInterval(timer);
      }, [fetchStatus]);

      const handleStartScan = async (force = false) => {
        setActionBusy(true);
        setErrorMsg(null);
        try {
          const res = await callApi('start-scan', { force });
          if (res && res.ok) {
            showToast('已生成登录二维码，请使用手机微信扫码');
            await fetchStatus(true);
          } else {
            setErrorMsg(res?.error || '发起扫码失败');
          }
        } catch (err) {
          setErrorMsg('请求失败: ' + err.message);
        } finally {
          setActionBusy(false);
        }
      };

      const handleCancelScan = async () => {
        setActionBusy(true);
        try {
          await callApi('cancel-scan');
          showToast('已取消扫码流程');
          await fetchStatus(true);
        } catch (err) {
          setErrorMsg('取消扫码失败: ' + err.message);
        } finally {
          setActionBusy(false);
        }
      };

      const handleLogout = async (accountId) => {
        setActionBusy(true);
        try {
          const res = await callApi('logout', { accountId });
          if (res && res.ok) {
            showToast('已断开连接并清除本地凭证');
            await fetchStatus(false);
          } else {
            setErrorMsg(res?.error || '退出失败');
          }
        } catch (err) {
          setErrorMsg('退出请求失败: ' + err.message);
        } finally {
          setActionBusy(false);
        }
      };

      const accounts = data?.accounts || [];
      const currentAccount = accounts[0] || null;
      const live = data?.live || { connected: false };
      const activeScan = data?.activeScan || null;

      // 状态徽标计算
      let badgeText = '未连接';
      let badgeColor = 'var(--dsw-alias-state-idle-primary, #6b7280)';
      let badgeBg = 'var(--dsw-alias-bg-layer-2, rgba(107, 114, 128, 0.12))';

      if (live.connected) {
        badgeText = '已连接 · 在线';
        badgeColor = 'var(--dsw-alias-state-success-primary, #10b981)';
        badgeBg = 'rgba(16, 185, 129, 0.12)';
      } else if (live.expired || live.errcode === -14) {
        badgeText = '已过期 (需重新扫码)';
        badgeColor = 'var(--dsw-alias-state-error-primary, #ef4444)';
        badgeBg = 'rgba(239, 68, 68, 0.12)';
      } else if (currentAccount) {
        badgeText = '连接异常 / 离线';
        badgeColor = 'var(--dsw-alias-state-warn-primary, #f59e0b)';
        badgeBg = 'rgba(245, 158, 11, 0.12)';
      }

      const cardStyle = {
        background: 'var(--dsw-alias-bg-layer-1, #ffffff)',
        border: '1px solid var(--dsw-alias-border-l1, #e5e7eb)',
        borderRadius: '10px',
        padding: '18px 20px',
        marginBottom: '16px',
      };

      const btnBase = {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        height: '34px',
        padding: '0 14px',
        fontSize: '13px',
        fontWeight: 500,
        borderRadius: '7px',
        cursor: actionBusy ? 'not-allowed' : 'pointer',
        opacity: actionBusy ? 0.6 : 1,
        border: '1px solid var(--dsw-alias-border-l2, #d1d5db)',
        background: 'var(--dsw-alias-bg-layer-1, #ffffff)',
        color: 'var(--dsw-alias-label-primary, inherit)',
        marginRight: '10px',
        transition: 'all 0.15s ease',
      };

      const btnPrimary = {
        ...btnBase,
        background: 'var(--dsw-alias-brand-primary, #4f6ef7)',
        color: '#ffffff',
        border: 'none',
      };

      const btnDanger = {
        ...btnBase,
        color: 'var(--dsw-alias-state-error-primary, #ef4444)',
        borderColor: 'rgba(239, 68, 68, 0.35)',
      };

      return h(
        'div',
        {
          style: {
            padding: '8px 4px',
            color: 'var(--dsw-alias-label-primary, inherit)',
            fontSize: '14px',
            lineHeight: 1.6,
            maxWidth: '680px',
          },
        },
        // 标题栏
        h(
          'div',
          { style: { marginBottom: '20px' } },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' } },
            h('h3', { style: { margin: 0, fontSize: '17px', fontWeight: 600 } }, '微信通道 (WeChat iLink 增强版)'),
            h(
              'span',
              {
                style: {
                  display: 'inline-flex',
                  alignItems: 'center',
                  padding: '4px 12px',
                  borderRadius: '999px',
                  fontSize: '12px',
                  fontWeight: 600,
                  color: badgeColor,
                  background: badgeBg,
                },
              },
              h('span', {
                style: {
                  width: '7px',
                  height: '7px',
                  borderRadius: '50%',
                  background: badgeColor,
                  marginRight: '7px',
                },
              }),
              badgeText
            )
          ),
          h(
            'div',
            { style: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary, #6b7280)', marginTop: '4px' } },
            '管理手机微信与 DeepSeek Harness 的实时双向通道、心跳守护与一键扫码登录。'
          )
        ),

        // 提示条
        toastMsg &&
          h(
            'div',
            {
              style: {
                padding: '10px 14px',
                marginBottom: '14px',
                borderRadius: '8px',
                background: 'rgba(16, 185, 129, 0.12)',
                color: 'var(--dsw-alias-state-success-primary, #10b981)',
                fontSize: '13px',
                fontWeight: 500,
              },
            },
            toastMsg
          ),

        errorMsg &&
          h(
            'div',
            {
              style: {
                padding: '10px 14px',
                marginBottom: '14px',
                borderRadius: '8px',
                background: 'rgba(239, 68, 68, 0.12)',
                color: 'var(--dsw-alias-state-error-primary, #ef4444)',
                fontSize: '13px',
              },
            },
            errorMsg
          ),

        // 当前账号与状态卡片
        h(
          'div',
          { style: cardStyle },
          h(
            'div',
            { style: { fontWeight: 600, fontSize: '14px', marginBottom: '12px' } },
            '当前连接状态'
          ),
          currentAccount
            ? h(
                'div',
                { style: { fontSize: '13px', display: 'grid', rowGap: '8px' } },
                h(
                  'div',
                  { style: { display: 'flex', justifyContent: 'space-between' } },
                  h('span', { style: { color: 'var(--dsw-alias-label-secondary, #6b7280)' } }, '绑定 Bot 账号 ID：'),
                  h('span', { style: { fontFamily: 'monospace', fontWeight: 500 } }, currentAccount.accountId)
                ),
                currentAccount.savedAt &&
                  h(
                    'div',
                    { style: { display: 'flex', justifyContent: 'space-between' } },
                    h('span', { style: { color: 'var(--dsw-alias-label-secondary, #6b7280)' } }, '授权凭证更新时间：'),
                    h('span', null, new Date(currentAccount.savedAt).toLocaleString())
                  ),
                h(
                  'div',
                  { style: { display: 'flex', justifyContent: 'space-between' } },
                  h('span', { style: { color: 'var(--dsw-alias-label-secondary, #6b7280)' } }, '接口实时探测：'),
                  h(
                    'span',
                    {
                      style: {
                        color: live.connected
                          ? 'var(--dsw-alias-state-success-primary, #10b981)'
                          : 'var(--dsw-alias-state-error-primary, #ef4444)',
                        fontWeight: 500,
                      },
                    },
                    live.connected
                      ? '正常通信中 (OK)'
                      : live.expired
                      ? '会话已过期 (errcode -14)'
                      : '未连通 (' + (live.reason || '未知原因') + ')'
                  )
                ),
                data?.lockOwnerPid &&
                  h(
                    'div',
                    { style: { display: 'flex', justifyContent: 'space-between' } },
                    h('span', { style: { color: 'var(--dsw-alias-label-secondary, #6b7280)' } }, '轮询实例进程：'),
                    h('span', { style: { fontFamily: 'monospace' } }, `PID ${data.lockOwnerPid} ${data.isPollingOwner ? '(当前实例)' : '(候补实例)'}`)
                  )
              )
            : h(
                'div',
                { style: { fontSize: '13px', color: 'var(--dsw-alias-label-secondary, #6b7280)' } },
                '当前尚未绑定任何微信账号凭证，请点击下方「扫码连接微信」进行绑定。'
              ),

          // 操作按钮组
          h(
            'div',
            { style: { marginTop: '16px', paddingTop: '14px', borderTop: '1px solid var(--dsw-alias-border-l1, #e5e7eb)', display: 'flex', flexWrap: 'wrap', gap: '8px' } },
            h(
              'button',
              {
                style: btnPrimary,
                disabled: actionBusy,
                onClick: () => handleStartScan(true),
              },
              currentAccount ? '重新扫码链接' : '扫码连接微信'
            ),
            h(
              'button',
              {
                style: btnBase,
                disabled: actionBusy || loading,
                onClick: () => {
                  fetchStatus(false);
                  showToast('已刷新实时连接状态');
                },
              },
              loading ? '检测中...' : '刷新状态'
            ),
            currentAccount &&
              h(
                'button',
                {
                  style: btnDanger,
                  disabled: actionBusy,
                  onClick: () => handleLogout(currentAccount.accountId),
                },
                '断开 / 退出登录'
              )
          )
        ),

        // 扫码区域卡片
        activeScan &&
          activeScan.status !== 'cancelled' &&
          h(
            'div',
            { style: cardStyle },
            h(
              'div',
              { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' } },
              h(
                'div',
                { style: { fontWeight: 600, fontSize: '14px' } },
                activeScan.status === 'waiting_scan'
                  ? '请使用手机微信扫描二维码'
                  : activeScan.status === 'scanned'
                  ? '已扫码，请在手机微信上点确认授权'
                  : activeScan.status === 'success'
                  ? '扫码连接成功！'
                  : activeScan.status === 'expired'
                  ? '二维码已过期'
                  : '正在准备二维码...'
              ),
              (activeScan.status === 'waiting_scan' || activeScan.status === 'scanned' || activeScan.status === 'starting') &&
                h(
                  'button',
                  {
                    style: { ...btnDanger, height: '28px', padding: '0 10px', fontSize: '12px', marginRight: 0 },
                    disabled: actionBusy,
                    onClick: handleCancelScan,
                  },
                  '取消扫码'
                )
            ),

            (activeScan.status === 'waiting_scan' || activeScan.status === 'scanned') &&
              activeScan.qrPngBase64 &&
              h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '12px 0' } },
                h('img', {
                  src: activeScan.qrPngBase64,
                  alt: '微信扫码登录',
                  style: {
                    width: '210px',
                    height: '210px',
                    borderRadius: '8px',
                    border: '1px solid var(--dsw-alias-border-l1, #e5e7eb)',
                    background: '#ffffff',
                    padding: '6px',
                  },
                }),
                h(
                  'div',
                  { style: { marginTop: '10px', fontSize: '12px', color: 'var(--dsw-alias-label-secondary, #6b7280)', textAlign: 'center' } },
                  activeScan.status === 'scanned'
                    ? '✅ 手机已扫码，请在微信界面点击「确认登录」...'
                    : '打开手机微信扫一扫，确认后自动完成连接并激活通道'
                ),
                activeScan.url &&
                  h(
                    'div',
                    { style: { marginTop: '6px', fontSize: '12px' } },
                    h(
                      'a',
                      {
                        href: activeScan.url,
                        target: '_blank',
                        rel: 'noreferrer',
                        style: { color: 'var(--dsw-alias-brand-primary, #4f6ef7)', textDecoration: 'none' },
                      },
                      '打开二维码网页直链 ↗'
                    )
                  )
              ),

            activeScan.status === 'expired' &&
              h(
                'div',
                { style: { fontSize: '13px', color: 'var(--dsw-alias-state-warn-primary, #f59e0b)' } },
                '当前二维码已超时失效，请点击上方「重新扫码链接」获取新二维码。'
              ),

            activeScan.status === 'failed' &&
              h(
                'div',
                { style: { fontSize: '13px', color: 'var(--dsw-alias-state-error-primary, #ef4444)' } },
                '获取二维码失败：' + (activeScan.error || '未知错误')
              )
          )
      );
    }

    return {
      inject: ['slots', 'connection'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              id: 'weixin',
              order: 2,
              label: () => '微信通道',
            },
            (props) => h(WeixinSettingsTab, { ...props, ctx, connection: ctx.connection })
          )
        );
      },
    };
  },
});
