import * as aws from '@pulumi/aws';

export const getExistingCertificate = async (domainName: string) => {
  return await aws.acm.getCertificate({
    domain: domainName,
    statuses: ['ISSUED'],
    mostRecent: true,
  });
};