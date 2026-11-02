import pyarrow.fs as fs, pyarrow.dataset as ds, pyarrow.compute as pc, os
s3=fs.S3FileSystem(anonymous=True, region='us-west-2', proxy_options=os.environ['HTTPS_PROXY'])
p='overturemaps-us-west-2/release/2026-10-21.0/theme=transportation/type=segment/'
print(s3.get_file_info(fs.FileSelector(p))[:2])
d=ds.dataset(p, filesystem=s3, format='parquet')
b=pc.field('bbox')
f=(pc.field('bbox','xmin')>121.50)&(pc.field('bbox','xmax')<121.66)&(pc.field('bbox','ymin')>25.10)&(pc.field('bbox','ymax')<25.24)&(pc.field('subtype')=='road')
t=d.to_table(columns=['id','names','class','geometry','connectors'], filter=f)
import pyarrow.parquet as pq
pq.write_table(t,'roads.parquet'); print(t.num_rows)
