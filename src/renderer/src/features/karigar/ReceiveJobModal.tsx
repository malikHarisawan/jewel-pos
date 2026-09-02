import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { App as AntApp, Alert, Button, Input, InputNumber, Modal, Space, Typography } from 'antd';
import { DeleteOutlined } from '@ant-design/icons';
import { api } from '../../lib/api.js';
import { gramsToMg, mgToGrams, formatWeight } from '../../../../shared/units/index.js';
import type { z } from 'zod';
import type { KarigarJobDTO } from '../../../../shared/contracts/index.js';

type Job = z.infer<typeof KarigarJobDTO>;

interface Props {
  job: Job | null;
  open: boolean;
  onClose: () => void;
}
interface Piece {
  key: number;
  name: string;
  tagNumber: string;
  grossG: number;
  netG: number;
}

/** Receive finished pieces back from a karigar and close the job. Shows a live
 * wastage preview against the agreed tolerance. */
export function ReceiveJobModal({ job, open, onClose }: Props) {
  const { t } = useTranslation();
  const { message } = AntApp.useApp();
  const qc = useQueryClient();
  const [pieces, setPieces] = useState<Piece[]>([]);
  const [keyC, setKeyC] = useState(1);

  useEffect(() => {
    if (open) {
      setPieces([{ key: 0, name: '', tagNumber: '', grossG: 0, netG: 0 }]);
      setKeyC(1);
    }
  }, [open]);

  const receivedNetMg = pieces.reduce((s, p) => s + gramsToMg(p.netG || 0), 0);
  const issuedNetMg = job?.issuedNetMg ?? 0;
  const actualWastageMg = issuedNetMg - receivedNetMg;
  const allowedWastageMg = Math.round((issuedNetMg * (job?.allowedWastageBp ?? 0)) / 10_000);
  const overTolerance = actualWastageMg > allowedWastageMg;

  const receive = useMutation({
    mutationFn: () =>
      api['karigar.receive']({
        jobId: job!.id,
        pieces: pieces
          .filter((p) => p.name.trim() && p.netG > 0)
          .map((p) => ({
            name: p.name.trim(),
            tagNumber: p.tagNumber.trim() || undefined,
            grossMg: gramsToMg(p.grossG),
            netMg: gramsToMg(p.netG),
          })),
      }),
    onSuccess: (done) => {
      void qc.invalidateQueries({ queryKey: ['karigar'] });
      void qc.invalidateQueries({ queryKey: ['items'] });
      void qc.invalidateQueries({ queryKey: ['stock'] });
      message.success(
        done.overTolerance ? t('karigar.receivedFlagged') : t('karigar.receivedOk'),
      );
      onClose();
    },
    onError: (e: Error) => message.error(e.message),
  });

  const valid =
    pieces.some((p) => p.name.trim() && p.netG > 0) && receivedNetMg <= issuedNetMg;

  return (
    <Modal
      title={`${t('karigar.receiveTitle')} — ${job?.jobNumber ?? ''}`}
      open={open}
      onOk={() => receive.mutate()}
      onCancel={onClose}
      okButtonProps={{ disabled: !valid }}
      confirmLoading={receive.isPending}
      okText={t('karigar.receiveBtn')}
      width={640}
      destroyOnHidden
    >
      {job && (
        <Typography.Paragraph type="secondary">
          {t('karigar.issuedWas')}: {formatWeight(job.issuedNetMg)} · {t('karigar.allowedWastage')}:{' '}
          {job.allowedWastageBp / 100}% ({formatWeight(allowedWastageMg)})
        </Typography.Paragraph>
      )}

      {pieces.map((p) => (
        <Space key={p.key} style={{ display: 'flex', marginBlockEnd: 8 }} wrap>
          <Input
            placeholder={t('karigar.pieceName')}
            style={{ width: 160 }}
            value={p.name}
            onChange={(e) =>
              setPieces((ps) => ps.map((x) => (x.key === p.key ? { ...x, name: e.target.value } : x)))
            }
          />
          <Input
            placeholder={t('karigar.pieceTag')}
            style={{ width: 110 }}
            value={p.tagNumber}
            onChange={(e) =>
              setPieces((ps) =>
                ps.map((x) => (x.key === p.key ? { ...x, tagNumber: e.target.value } : x)),
              )
            }
          />
          <InputNumber
            addonAfter="g gross"
            min={0}
            step={0.001}
            value={p.grossG}
            onChange={(v) =>
              setPieces((ps) => ps.map((x) => (x.key === p.key ? { ...x, grossG: v ?? 0 } : x)))
            }
          />
          <InputNumber
            addonAfter="g net"
            min={0}
            step={0.001}
            value={p.netG}
            onChange={(v) =>
              setPieces((ps) => ps.map((x) => (x.key === p.key ? { ...x, netG: v ?? 0 } : x)))
            }
          />
          {pieces.length > 1 && (
            <Button
              type="text"
              icon={<DeleteOutlined />}
              onClick={() => setPieces((ps) => ps.filter((x) => x.key !== p.key))}
            />
          )}
        </Space>
      ))}
      <Button
        size="small"
        type="dashed"
        onClick={() => {
          setPieces((ps) => [...ps, { key: keyC, name: '', tagNumber: '', grossG: 0, netG: 0 }]);
          setKeyC((k) => k + 1);
        }}
      >
        {t('karigar.addPiece')}
      </Button>

      <div style={{ marginBlockStart: 16 }}>
        <Typography.Text>
          {t('karigar.received')}: <strong>{mgToGrams(receivedNetMg).toFixed(3)} g</strong> ·{' '}
          {t('karigar.wastage')}: <strong>{mgToGrams(actualWastageMg).toFixed(3)} g</strong>
        </Typography.Text>
      </div>
      {receivedNetMg > issuedNetMg && (
        <Alert
          type="error"
          showIcon
          style={{ marginBlockStart: 8 }}
          message={t('karigar.tooMuch')}
        />
      )}
      {valid && overTolerance && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBlockStart: 8 }}
          message={t('karigar.willFlag')}
        />
      )}
    </Modal>
  );
}
