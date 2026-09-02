import { useTranslation } from 'react-i18next';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { App as AntApp, Form, InputNumber, Modal, Select } from 'antd';
import { api } from '../../lib/api.js';
import { useCatalog } from '../items/useCatalog.js';
import { gramsToMg } from '../../../../shared/units/index.js';

interface Props {
  open: boolean;
  onClose: () => void;
}
interface Values {
  purityId: number;
  grams: number;
  notes?: string;
}

/** Buy raw metal into a per-purity raw lot — the stock you later issue to karigars. */
export function RawIntakeModal({ open, onClose }: Props) {
  const { t } = useTranslation();
  const { message } = AntApp.useApp();
  const qc = useQueryClient();
  const catalog = useCatalog();
  const [form] = Form.useForm<Values>();

  const intake = useMutation({
    mutationFn: (v: Values) =>
      api['karigar.rawIntake']({ purityId: v.purityId, netMg: gramsToMg(v.grams), notes: v.notes }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['karigar'] });
      void qc.invalidateQueries({ queryKey: ['stock'] });
      message.success(t('karigar.rawAdded'));
      form.resetFields();
      onClose();
    },
    onError: (e: Error) => message.error(e.message),
  });

  return (
    <Modal
      title={t('karigar.buyRawTitle')}
      open={open}
      onOk={() => form.submit()}
      onCancel={onClose}
      confirmLoading={intake.isPending}
      okText={t('karigar.buyRawBtn')}
      destroyOnHidden
    >
      <Form<Values> form={form} layout="vertical" onFinish={(v) => intake.mutate(v)}>
        <Form.Item name="purityId" label={t('items.field.purity')} rules={[{ required: true }]}>
          <Select
            options={(catalog.data?.purities ?? []).map((p) => ({ value: p.id, label: p.label }))}
          />
        </Form.Item>
        <Form.Item name="grams" label={t('karigar.rawGrams')} rules={[{ required: true }]}>
          <InputNumber min={0.001} step={0.001} style={{ width: '100%' }} addonAfter="g" />
        </Form.Item>
      </Form>
    </Modal>
  );
}
