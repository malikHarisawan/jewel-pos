import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App as AntApp, Button, Form, Input, InputNumber, Modal, Select, Typography } from 'antd';
import { api } from '../../lib/api.js';
import { useCatalog } from '../items/useCatalog.js';
import { gramsToMg, rupeesToPaisa, formatWeight } from '../../../../shared/units/index.js';

interface Props {
  open: boolean;
  onClose: () => void;
}
interface Values {
  karigarPartyId: number;
  purityId: number;
  grossG: number;
  netG: number;
  wastagePct: number;
  labourRateRupees: number;
}

/** Issue metal to a karigar (opens a new job). */
export function IssueJobModal({ open, onClose }: Props) {
  const { t } = useTranslation();
  const { message } = AntApp.useApp();
  const qc = useQueryClient();
  const catalog = useCatalog();
  const [form] = Form.useForm<Values>();
  const [newKarigar, setNewKarigar] = useState('');

  const karigars = useQuery({
    queryKey: ['parties', 'KARIGAR'],
    queryFn: () => api['parties.list']({ kind: 'KARIGAR', limit: 500 }),
    enabled: open,
  });

  const purityId = Form.useWatch('purityId', form);
  const rawBal = useQuery({
    queryKey: ['karigar', 'rawBalance', purityId],
    queryFn: () => api['karigar.rawBalance']({ purityId: purityId! }),
    enabled: open && purityId != null,
  });

  const addKarigar = useMutation({
    mutationFn: (name: string) => api['parties.create']({ kind: 'KARIGAR', name }),
    onSuccess: (p) => {
      void qc.invalidateQueries({ queryKey: ['parties', 'KARIGAR'] });
      form.setFieldValue('karigarPartyId', p.id);
      setNewKarigar('');
      message.success(t('karigar.added'));
    },
    onError: (e: Error) => message.error(e.message),
  });

  const issue = useMutation({
    mutationFn: (v: Values) =>
      api['karigar.issue']({
        karigarPartyId: v.karigarPartyId,
        purityId: v.purityId,
        issuedGrossMg: gramsToMg(v.grossG),
        issuedNetMg: gramsToMg(v.netG),
        allowedWastageBp: Math.round((v.wastagePct || 0) * 100),
        labourRatePaisa: rupeesToPaisa(v.labourRateRupees || 0),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['karigar'] });
      void qc.invalidateQueries({ queryKey: ['stock'] });
      message.success(t('karigar.issued'));
      form.resetFields();
      onClose();
    },
    onError: (e: Error) => message.error(e.message),
  });

  return (
    <Modal
      title={t('karigar.issueTitle')}
      open={open}
      onOk={() => form.submit()}
      onCancel={onClose}
      confirmLoading={issue.isPending}
      okText={t('karigar.issueBtn')}
      destroyOnHidden
    >
      <Form<Values> form={form} layout="vertical" onFinish={(v) => issue.mutate(v)}>
        <Form.Item name="karigarPartyId" label={t('karigar.karigar')} rules={[{ required: true }]}>
          <Select
            showSearch
            optionFilterProp="label"
            loading={karigars.isLoading}
            placeholder={t('karigar.pickKarigar')}
            options={(karigars.data ?? []).map((k) => ({ value: k.id, label: k.name }))}
            popupRender={(menu) => (
              <>
                {menu}
                <div style={{ display: 'flex', gap: 8, padding: 8 }}>
                  <Input
                    placeholder={t('karigar.newName')}
                    value={newKarigar}
                    onChange={(e) => setNewKarigar(e.target.value)}
                    onKeyDown={(e) => e.stopPropagation()}
                  />
                  <Button
                    type="primary"
                    disabled={!newKarigar.trim()}
                    loading={addKarigar.isPending}
                    onClick={() => addKarigar.mutate(newKarigar.trim())}
                  >
                    {t('karigar.add')}
                  </Button>
                </div>
              </>
            )}
          />
        </Form.Item>
        <Form.Item name="purityId" label={t('items.field.purity')} rules={[{ required: true }]}>
          <Select
            options={(catalog.data?.purities ?? []).map((p) => ({ value: p.id, label: p.label }))}
          />
        </Form.Item>
        {purityId != null && (
          <Typography.Paragraph type="secondary" style={{ marginBlockStart: -8 }}>
            {t('karigar.onHand')}: {formatWeight(rawBal.data?.netMg ?? 0)}
          </Typography.Paragraph>
        )}
        <Form.Item name="grossG" label={t('karigar.issueGrossG')} rules={[{ required: true }]}>
          <InputNumber min={0} step={0.001} style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item name="netG" label={t('karigar.issueNetG')} rules={[{ required: true }]}>
          <InputNumber min={0} step={0.001} style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item name="wastagePct" label={t('karigar.allowedWastage')} initialValue={2}>
          <InputNumber min={0} step={0.1} style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item name="labourRateRupees" label={t('karigar.labourRate')} initialValue={0}>
          <InputNumber min={0} step={1} style={{ width: '100%' }} addonBefore="Rs" addonAfter="/g" />
        </Form.Item>
      </Form>
    </Modal>
  );
}
